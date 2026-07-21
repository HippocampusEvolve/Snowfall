package ru.antonovai.snowfall;

import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

// Игра во весь экран: статус-бар и навигация убраны, кадр уходит под вырез
// камеры (windowLayoutInDisplayCutoutMode в теме), тач-кнопки отступают от
// краёв через env(safe-area-inset-*) в CSS.
// Панели возвращаются свайпом от края на пару секунд и снова прячутся
// (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE) — выйти из игры можно всегда.
// Экран не гаснет: в Snowfall можно долго стоять и смотреть на снег, а
// таймаут гасил бы дисплей посреди партии.
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        hideSystemBars();
    }

    // после сворачивания/диалога панели возвращаются — прячем снова
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c =
                new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
