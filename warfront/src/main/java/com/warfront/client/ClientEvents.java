package com.warfront.client;

import com.warfront.Warfront;
import com.warfront.entity.TankEntity;
import com.warfront.net.ActionPacket;
import com.warfront.net.Net;
import net.minecraft.client.Minecraft;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = Warfront.ID, value = Dist.CLIENT)
public final class ClientEvents {
    private ClientEvents() {
    }

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        Minecraft mc = Minecraft.getInstance();
        while (ClientSetup.FIRE.consumeClick()) {
            if (mc.player != null && mc.player.getVehicle() instanceof TankEntity) {
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.FIRE, 0, 0));
            }
        }
        while (ClientSetup.MAP.consumeClick()) {
            if (mc.player != null && mc.screen == null) {
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.OPEN, 0, 0));
            }
        }
    }
}
