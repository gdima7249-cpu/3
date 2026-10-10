package com.warfront.client;

import com.mojang.blaze3d.vertex.PoseStack;
import com.warfront.Warfront;
import com.warfront.entity.SoldierEntity;
import net.minecraft.client.model.HumanoidModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.client.renderer.entity.layers.HumanoidArmorLayer;
import net.minecraft.resources.ResourceLocation;

/** Солдат: броня видна, при стрельбе поднимает оружие двумя руками. */
public class SoldierRenderer extends HumanoidMobRenderer<SoldierEntity, HumanoidModel<SoldierEntity>> {
    private static final ResourceLocation FRIEND = new ResourceLocation(Warfront.ID, "textures/entity/soldier.png");
    private static final ResourceLocation FOE = new ResourceLocation(Warfront.ID, "textures/entity/soldier_enemy.png");

    public SoldierRenderer(EntityRendererProvider.Context ctx) {
        super(ctx, new HumanoidModel<>(ctx.bakeLayer(ModelLayers.PLAYER)), 0.5F);
        addLayer(new HumanoidArmorLayer<>(this,
                new HumanoidModel<>(ctx.bakeLayer(ModelLayers.PLAYER_INNER_ARMOR)),
                new HumanoidModel<>(ctx.bakeLayer(ModelLayers.PLAYER_OUTER_ARMOR)),
                ctx.getModelManager()));
    }

    @Override
    public void render(SoldierEntity entity, float yaw, float partialTick, PoseStack pose,
                       MultiBufferSource buffer, int light) {
        boolean armed = !entity.getMainHandItem().isEmpty();
        boolean aiming = armed && entity.isAggressive();
        model.rightArmPose = aiming ? HumanoidModel.ArmPose.BOW_AND_ARROW : (armed ? HumanoidModel.ArmPose.ITEM : HumanoidModel.ArmPose.EMPTY);
        model.leftArmPose = aiming ? HumanoidModel.ArmPose.BOW_AND_ARROW : HumanoidModel.ArmPose.EMPTY;
        super.render(entity, yaw, partialTick, pose, buffer, light);
    }

    @Override
    public ResourceLocation getTextureLocation(SoldierEntity entity) {
        return entity.isEnemy() ? FOE : FRIEND;
    }
}
