package app.quire.reader;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Quire's own native helper (the page flip picture) must be known
        // before Capacitor starts.
        registerPlugin(PageSnapshotPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // "Share" > Quire sends ACTION_SEND with the file in EXTRA_STREAM, while
    // "Open with" sends ACTION_VIEW with the file as the data. Capacitor's App
    // plugin only reports the second kind, so turn the first into the second.
    // BridgeActivity also passes the launch intent through here, so this covers
    // a cold start as well.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(shareToView(intent));
    }

    private static Intent shareToView(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return intent;
        Uri stream;
        if (Build.VERSION.SDK_INT >= 33) {
            stream = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            @SuppressWarnings("deprecation")
            Uri legacy = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            stream = legacy;
        }
        if (stream == null) return intent;
        Intent view = new Intent(intent);
        view.setAction(Intent.ACTION_VIEW);
        view.setData(stream);
        return view;
    }
}
