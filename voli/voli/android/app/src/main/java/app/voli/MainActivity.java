package app.voli;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Voli Android shell. A WebView runs the offline web app bundled in assets/.
 * Everything is served from a virtual https origin so module scripts and Range requests work:
 *   https://appassets.androidplatform.net/...        -> assets (the web app)
 *   https://appassets.androidplatform.net/packs/...  -> downloaded state packs in app storage
 * No third-party libraries are used, and no location data ever leaves the device.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final int REQ_LOCATION = 1;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d+)-(\\d*)");

    private WebView web;
    private File packsDir;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> downloads = new ConcurrentHashMap<>();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        packsDir = new File(getFilesDir(), "packs");
        //noinspection ResultOfMethodCallIgnored
        packsDir.mkdirs();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0C1828);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "VoliNative");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestLocation();
                }
            }
        });

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(new Locale("pt", "BR"));
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
            }
        });

        if (!hasLocationPermission()) requestLocation();
        web.loadUrl(ORIGIN + "/index.html");
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestLocation() {
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
        } else if (requestCode == REQ_LOCATION && hasLocationPermission()) {
            web.reload();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.dispatchEvent(new Event('vt-back'))", null);
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        for (AtomicBoolean c : downloads.values()) c.set(true);
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ JS events

    private void emit(String name, JSONObject data) {
        final String js = "window.__vtEmit(" + JSONObject.quote(name) + "," + JSONObject.quote(data.toString()) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    // ------------------------------------------------------------------ local web server

    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (!HOST.equals(uri.getHost())) return null;
            String path = uri.getPath() == null ? "/" : uri.getPath();
            try {
                if (path.startsWith("/packs/")) {
                    String name = new File(path).getName();
                    File f = new File(packsDir, name);
                    if (!f.isFile() || name.startsWith(".")) return notFound();
                    return serveFile(f, req.getRequestHeaders());
                }
                String asset = path.equals("/") ? "index.html" : path.substring(1);
                if (asset.contains("..")) return notFound();
                InputStream in = getAssets().open(asset);
                WebResourceResponse r = new WebResourceResponse(mime(asset), mime(asset).startsWith("text") || asset.endsWith(".mjs") || asset.endsWith(".js") ? "utf-8" : null, in);
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-cache");
                r.setResponseHeaders(h);
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (HOST.equals(uri.getHost())) return false;
            try {
                if ("tel".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_DIAL, uri));
                } else {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse serveFile(File f, Map<String, String> headers) throws IOException {
        long size = f.length();
        String range = null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();
        }
        Map<String, String> h = new HashMap<>();
        h.put("Accept-Ranges", "bytes");
        h.put("Cache-Control", "no-cache");
        String type = mime(f.getName());
        if (range != null) {
            Matcher m = RANGE.matcher(range);
            if (m.find()) {
                long start = Long.parseLong(m.group(1));
                long end = m.group(2).isEmpty() ? size - 1 : Math.min(Long.parseLong(m.group(2)), size - 1);
                if (start >= size || end < start) {
                    h.put("Content-Range", "bytes */" + size);
                    return new WebResourceResponse(type, null, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
                }
                long len = end - start + 1;
                FileInputStream in = new FileInputStream(f);
                long skipped = 0;
                while (skipped < start) {
                    long n = in.skip(start - skipped);
                    if (n <= 0) break;
                    skipped += n;
                }
                h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
                h.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(type, null, 206, "Partial Content", h, new LimitedStream(in, len));
            }
        }
        h.put("Content-Length", String.valueOf(size));
        return new WebResourceResponse(type, null, 200, "OK", h, new FileInputStream(f));
    }

    private static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".pbf")) return "application/x-protobuf";
        return "application/octet-stream";
    }

    /** Stream that stops after a fixed number of bytes (for HTTP Range responses). */
    private static class LimitedStream extends FilterInputStream {
        private long left;

        LimitedStream(InputStream in, long limit) {
            super(in);
            left = limit;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), left);
        }
    }

    // ------------------------------------------------------------------ downloads

    private static HttpURLConnection open(String url, long from) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "Voli/" + BuildConfig.VERSION_NAME + " (Android)");
        if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
        // GitHub release assets redirect to another https host; follow manually if needed.
        int code = c.getResponseCode();
        int hops = 0;
        while ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && hops++ < 5) {
            String loc = c.getHeaderField("Location");
            c.disconnect();
            c = (HttpURLConnection) new URL(new URL(url), loc).openConnection();
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
            code = c.getResponseCode();
        }
        return c;
    }

    private void download(String uf, JSONArray files, String metaJson, AtomicBoolean cancel) {
        File tmp = new File(packsDir, ".tmp-" + uf);
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        long total = 0;
        try {
            for (int i = 0; i < files.length(); i++) total += files.getJSONObject(i).optLong("size", 0);
            long doneBefore = 0;
            long lastEmit = 0;
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String name = new File(f.getString("name")).getName();
                long expected = f.optLong("size", -1);
                File out = new File(tmp, name);
                long have = out.isFile() ? out.length() : 0;
                if (expected > 0 && have == expected) {
                    doneBefore += have;
                    continue;
                }
                HttpURLConnection c = open(f.getString("url"), have);
                int code = c.getResponseCode();
                boolean append = code == 206 && have > 0;
                if (code != 200 && code != 206) throw new IOException("HTTP " + code + " (" + name + ")");
                if (!append) have = 0;
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out, append)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    long got = have;
                    while ((n = in.read(buf)) > 0) {
                        if (cancel.get()) throw new IOException("cancelled");
                        os.write(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 500) {
                            lastEmit = now;
                            JSONObject p = new JSONObject();
                            p.put("uf", uf).put("file", name).put("done", doneBefore + got).put("total", total);
                            emit("progress", p);
                        }
                    }
                    if (expected > 0 && got != expected) throw new IOException("Arquivo incompleto: " + name);
                    doneBefore += got;
                } finally {
                    c.disconnect();
                }
            }
            // All files complete: replace the installed pack atomically-ish.
            for (int i = 0; i < files.length(); i++) {
                String name = new File(files.getJSONObject(i).getString("name")).getName();
                File src = new File(tmp, name);
                File dst = new File(packsDir, name);
                if (dst.exists() && !dst.delete()) throw new IOException("Não foi possível substituir " + name);
                if (!src.renameTo(dst)) throw new IOException("Não foi possível mover " + name);
            }
            try (OutputStream os = new FileOutputStream(new File(packsDir, uf + ".meta.json"))) {
                os.write(metaJson.getBytes(StandardCharsets.UTF_8));
            }
            deleteRecursive(tmp);
            emit("downloaded", new JSONObject().put("uf", uf));
        } catch (Exception e) {
            try {
                if (cancel.get()) deleteRecursive(tmp); // keep partial files otherwise, so the download can resume
                emit("downloadError", new JSONObject().put("uf", uf).put("message", cancel.get() ? "cancelado" : String.valueOf(e.getMessage())));
            } catch (JSONException ignored) {
            }
        } finally {
            downloads.remove(uf);
            if (downloads.isEmpty()) runOnUiThread(() -> getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        }
    }

    private static void deleteRecursive(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String readFile(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
            return new String(b, 0, off, StandardCharsets.UTF_8);
        }
    }

    // ------------------------------------------------------------------ bridge

    private class Bridge {
        @JavascriptInterface
        public String getConfig() {
            try {
                return new JSONObject().put("packsBaseUrl", BuildConfig.PACKS_BASE_URL).put("appVersion", BuildConfig.VERSION_NAME).toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String listPacks() {
            JSONObject out = new JSONObject();
            File[] all = packsDir.listFiles();
            if (all == null) return "{}";
            try {
                for (File f : all) {
                    String n = f.getName();
                    if (!n.endsWith(".meta.json")) continue;
                    String uf = n.substring(0, n.length() - ".meta.json".length());
                    JSONObject files = new JSONObject();
                    for (File g : all) {
                        String gn = g.getName();
                        if (g.isFile() && !gn.endsWith(".meta.json") && (gn.startsWith(uf + ".") || gn.startsWith(uf + "-"))) {
                            files.put(gn, g.length());
                        }
                    }
                    JSONObject meta;
                    try {
                        meta = new JSONObject(readFile(f));
                    } catch (Exception e) {
                        meta = new JSONObject();
                    }
                    out.put(uf, new JSONObject().put("meta", meta).put("files", files));
                }
            } catch (JSONException ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface
        public void fetchText(String reqId, String url) {
            io.execute(() -> {
                JSONObject r = new JSONObject();
                try {
                    r.put("reqId", reqId);
                    HttpURLConnection c = open(url, 0);
                    int code = c.getResponseCode();
                    r.put("status", code);
                    if (code == 200) {
                        try (InputStream in = c.getInputStream()) {
                            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                            r.put("ok", true).put("body", bo.toString("UTF-8"));
                        }
                    } else {
                        r.put("ok", false);
                    }
                    c.disconnect();
                } catch (Exception e) {
                    try {
                        r.put("ok", false).put("error", String.valueOf(e.getMessage()));
                    } catch (JSONException ignored) {
                    }
                }
                emit("fetchText", r);
            });
        }

        @JavascriptInterface
        public void downloadPack(String uf, String filesJson, String metaJson) {
            if (!uf.matches("[a-z]{2}") || downloads.containsKey(uf)) return;
            AtomicBoolean cancel = new AtomicBoolean(false);
            downloads.put(uf, cancel);
            runOnUiThread(() -> getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
            io.execute(() -> {
                try {
                    download(uf, new JSONArray(filesJson), metaJson, cancel);
                } catch (JSONException e) {
                    downloads.remove(uf);
                }
            });
        }

        @JavascriptInterface
        public void cancelDownload(String uf) {
            AtomicBoolean c = downloads.get(uf);
            if (c != null) c.set(true);
        }

        @JavascriptInterface
        public boolean deletePack(String uf) {
            if (!uf.matches("[a-z]{2}")) return false;
            File[] all = packsDir.listFiles();
            boolean ok = true;
            if (all != null) {
                for (File f : all) {
                    String n = f.getName();
                    if (n.startsWith(uf + ".") || n.startsWith(uf + "-")) ok &= f.delete();
                }
            }
            return ok;
        }

        @JavascriptInterface
        public boolean isWifi() {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return nc != null && !cm.isActiveNetworkMetered()
                    && (nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET));
        }

        @JavascriptInterface
        public String freeSpace() {
            return String.valueOf(getFilesDir().getUsableSpace());
        }

        @JavascriptInterface
        public void speak(String text) {
            if (ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "vt");
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else if (downloads.isEmpty()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(ms, 1000)), VibrationEffect.DEFAULT_AMPLITUDE));
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> moveTaskToBack(true));
        }
    }
}
