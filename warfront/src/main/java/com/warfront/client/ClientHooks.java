package com.warfront.client;

import com.warfront.kingdom.KingdomView;
import net.minecraft.client.Minecraft;

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
}
