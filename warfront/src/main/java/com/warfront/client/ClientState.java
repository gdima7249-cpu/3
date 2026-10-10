package com.warfront.client;

import com.warfront.net.HudPacket;

/** Состояние интерфейса на клиенте. */
public final class ClientState {
    public static HudPacket hud;
    public static long alertUntil;
    public static String alertText = "";

    private ClientState() {
    }
}
