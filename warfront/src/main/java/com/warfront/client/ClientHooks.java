package com.warfront.client;

import com.warfront.kingdom.KingdomView;
import com.warfront.net.HudPacket;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.sounds.SoundEvents;

/** Вызывается из сетевых пакетов только на клиенте. */
public final class ClientHooks {
    private ClientHooks() {
    }

    public static void onSync(boolean open, KingdomView view) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.screen instanceof CommandMapScreen screen) {
            screen.update(view);
        } else if (open) {
            mc.setScreen(new CommandMapScreen(view));
        }
    }

    public static void hud(HudPacket packet) {
        ClientState.hud = packet;
    }

    /** Уведомление в углу экрана вместо спама в чате. */
    public static void notify(String title, String text, int kind) {
        Minecraft mc = Minecraft.getInstance();
        if (kind == 99) {
            AutoShots.handle(text);
            return;
        }
        ClientState.addNote(title, text, kind);
        if (kind == 1) mc.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.BELL_BLOCK, 0.8F));
    }
}
