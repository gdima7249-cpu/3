package com.warfront.client;

import com.warfront.Warfront;
import com.warfront.entity.SoldierEntity;
import net.minecraft.client.model.HumanoidModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.resources.ResourceLocation;

public class SoldierRenderer extends HumanoidMobRenderer<SoldierEntity, HumanoidModel<SoldierEntity>> {
    private static final ResourceLocation FRIEND = new ResourceLocation(Warfront.ID, "textures/entity/soldier.png");
    private static final ResourceLocation FOE = new ResourceLocation(Warfront.ID, "textures/entity/soldier_enemy.png");

    public SoldierRenderer(EntityRendererProvider.Context ctx) {
        super(ctx, new HumanoidModel<>(ctx.bakeLayer(ModelLayers.PLAYER)), 0.5F);
    }

    @Override
    public ResourceLocation getTextureLocation(SoldierEntity entity) {
        return entity.isEnemy() ? FOE : FRIEND;
    }
}
