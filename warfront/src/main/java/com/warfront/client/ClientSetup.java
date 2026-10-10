package com.warfront.client;

import com.mojang.blaze3d.platform.InputConstants;
import com.warfront.ModEntities;
import com.warfront.Warfront;
import net.minecraft.client.KeyMapping;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.EntityRenderersEvent;
import net.minecraftforge.client.event.RegisterGuiOverlaysEvent;
import net.minecraftforge.client.event.RegisterKeyMappingsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = Warfront.ID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
public final class ClientSetup {
    public static final KeyMapping FIRE = new KeyMapping("key.warfront.fire", InputConstants.KEY_R, "key.categories.warfront");
    public static final KeyMapping MAP = new KeyMapping("key.warfront.map", InputConstants.KEY_M, "key.categories.warfront");

    private ClientSetup() {
    }

    @SubscribeEvent
    public static void renderers(EntityRenderersEvent.RegisterRenderers event) {
        event.registerEntityRenderer(ModEntities.SOLDIER.get(), SoldierRenderer::new);
        event.registerEntityRenderer(ModEntities.TANK.get(), TankRenderer::new);
        event.registerEntityRenderer(ModEntities.BULLET.get(), BulletRenderer::new);
        event.registerEntityRenderer(ModEntities.ROCKET.get(), BulletRenderer::new);
    }

    @SubscribeEvent
    public static void layers(EntityRenderersEvent.RegisterLayerDefinitions event) {
        event.registerLayerDefinition(TankModel.LAYER, TankModel::createLayer);
    }

    @SubscribeEvent
    public static void overlays(RegisterGuiOverlaysEvent event) {
        event.registerAboveAll("warfront_hud", new HudOverlay());
    }

    @SubscribeEvent
    public static void keys(RegisterKeyMappingsEvent event) {
        event.register(FIRE);
        event.register(MAP);
    }
}
