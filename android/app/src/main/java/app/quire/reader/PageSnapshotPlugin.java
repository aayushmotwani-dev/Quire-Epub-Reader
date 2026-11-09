package app.quire.reader;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.view.PixelCopy;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;

/**
 * A picture of part of the page, for the page flip. JavaScript calls
 * Capacitor.Plugins.PageSnapshot.capture({ x, y, width, height, ratio }) with
 * the area in CSS pixels and window.devicePixelRatio. The answer is a JPEG as
 * base64 in "data". PixelCopy needs Android 8 (API 26); older phones get an
 * error and the reader slides the page instead.
 */
@CapacitorPlugin(name = "PageSnapshot")
public class PageSnapshotPlugin extends Plugin {

    private static final int MAX_SIDE = 4096; // pixels, keeps memory in check
    private HandlerThread worker;
    private Handler handler;

    @PluginMethod
    public void capture(PluginCall call) {
        if (Build.VERSION.SDK_INT < 26) {
            call.reject("Needs Android 8 or newer");
            return;
        }
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        Double width = call.getDouble("width");
        Double height = call.getDouble("height");
        Double ratio = call.getDouble("ratio");
        if (x == null || y == null || width == null || height == null || width < 1 || height < 1) {
            call.reject("Invalid area");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }
        activity.runOnUiThread(() -> copy(call, activity, x, y, width, height, ratio));
    }

    private void copy(PluginCall call, Activity activity, double x, double y, double width, double height, Double ratio) {
        try {
            WebView web = getBridge().getWebView();
            Window window = activity.getWindow();
            if (web == null || window == null) {
                call.reject("No web view");
                return;
            }
            double scale = ratio != null && ratio > 0.5 && ratio < 6
                ? ratio
                : web.getResources().getDisplayMetrics().density;
            int[] at = new int[2];
            web.getLocationInWindow(at);
            Rect area = new Rect(
                at[0] + (int) Math.round(x * scale),
                at[1] + (int) Math.round(y * scale),
                at[0] + (int) Math.round((x + width) * scale),
                at[1] + (int) Math.round((y + height) * scale)
            );
            View decor = window.getDecorView();
            if (!area.intersect(0, 0, decor.getWidth(), decor.getHeight())
                || area.width() < 1 || area.height() < 1
                || area.width() > MAX_SIDE || area.height() > MAX_SIDE) {
                call.reject("Area is off screen");
                return;
            }
            Bitmap bitmap = Bitmap.createBitmap(area.width(), area.height(), Bitmap.Config.ARGB_8888);
            PixelCopy.request(window, area, bitmap, result -> {
                // Runs on the worker thread: encode there, answer on the UI thread.
                if (result != PixelCopy.SUCCESS) {
                    bitmap.recycle();
                    activity.runOnUiThread(() -> call.reject("Copy failed"));
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out);
                bitmap.recycle();
                JSObject answer = new JSObject();
                answer.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                activity.runOnUiThread(() -> call.resolve(answer));
            }, workerHandler());
        } catch (RuntimeException e) {
            call.reject("Snapshot failed", e);
        }
    }

    private Handler workerHandler() {
        if (handler == null) {
            worker = new HandlerThread("PageSnapshot");
            worker.start();
            handler = new Handler(worker.getLooper());
        }
        return handler;
    }

    @Override
    protected void handleOnDestroy() {
        if (worker != null) worker.quitSafely();
        worker = null;
        handler = null;
    }
}
