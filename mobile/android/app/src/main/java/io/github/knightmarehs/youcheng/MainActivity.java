package io.github.knightmarehs.youcheng;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * 全屏沉浸：隐藏状态栏与导航栏（同 iPhone 隐藏状态栏），从屏幕边缘划出后过一会儿自动收回。
 * 切到后台再回来、弹窗关掉后系统会把栏放出来，所以拿回焦点时再藏一次。
 * 刘海/挖孔仍算安全区，网页里 env(safe-area-inset-*) 照常避开（Capacitor SystemBars 插件负责传值）。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
