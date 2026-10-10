package com.warfront.client;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.warfront.net.ActionPacket;
import com.warfront.net.Net;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;

import java.io.File;

/** Только для CI: по команде сервера делает скриншоты и управляет интерфейсом. */
public final class AutoShots {
    private static String pending;
    private static int delay;

    private AutoShots() {
    }

    public static void handle(String name) {
        Minecraft mc = Minecraft.getInstance();
        if (name.startsWith("CAM:")) {
            mc.options.setCameraType(name.endsWith("third") ? CameraType.THIRD_PERSON_BACK : CameraType.FIRST_PERSON);
        } else if (name.startsWith("UI:")) {
            switch (name.substring(3)) {
                case "map" -> Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.OPEN, 0, 0));
                case "build" -> {
                    if (mc.screen instanceof CommandMapScreen s) s.debugTab(1);
                }
                case "log" -> {
                    if (mc.screen instanceof CommandMapScreen s) s.debugTab(2);
                }
                case "close" -> mc.setScreen(null);
                default -> { }
            }
        } else if (name.equals("EXIT")) {
            mc.stop();
        } else {
            pending = name;
            delay = 6;
        }
    }

    /** Вызывается каждый клиентский тик. */
    public static void tick() {
        if (pending == null) return;
        if (--delay > 0) return;
        String name = pending;
        pending = null;
        Minecraft mc = Minecraft.getInstance();
        try {
            RenderTarget target = mc.getMainRenderTarget();
            try (NativeImage image = Screenshot.takeScreenshot(target)) {
                File dir = new File(mc.gameDirectory, "autotest");
                dir.mkdirs();
                image.writeToFile(new File(dir, name + ".png"));
            }
            System.out.println("[autotest] screenshot " + name);
        } catch (Exception e) {
            System.out.println("[autotest] screenshot failed " + name + ": " + e);
        }
    }
}
