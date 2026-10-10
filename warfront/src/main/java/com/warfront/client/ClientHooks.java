package com.warfront.client;

import com.warfront.kingdom.KingdomView;
import com.warfront.net.HudPacket;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.toasts.SystemToast;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.network.chat.Component;
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

    /** Всплывающее уведомление вместо спама в чате. */
    public static void notify(String title, String text, int kind) {
        Minecraft mc = Minecraft.getInstance();
        if (kind == 99) {
            AutoShots.handle(text);
            return;
        }
        SystemToast.add(mc.getToasts(), SystemToast.SystemToastIds.PERIODIC_NOTIFICATION,
                Component.literal(title), Component.literal(text));
        if (kind == 1) {
            ClientState.alertUntil = System.currentTimeMillis() + 7000;
            ClientState.alertText = title + ": " + text;
            mc.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.BELL_BLOCK, 0.8F));
        }
    }
}
