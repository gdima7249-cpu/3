package com.warfront.client;

import com.mojang.blaze3d.vertex.PoseStack;
import com.warfront.Warfront;
import com.warfront.entity.TankEntity;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.MobRenderer;
import net.minecraft.resources.ResourceLocation;

public class TankRenderer extends MobRenderer<TankEntity, TankModel> {
    private static final ResourceLocation TEXTURE = new ResourceLocation(Warfront.ID, "textures/entity/tank.png");

    public TankRenderer(EntityRendererProvider.Context ctx) {
        super(ctx, new TankModel(ctx.bakeLayer(TankModel.LAYER)), 1.4F);
    }

    @Override
    protected void scale(TankEntity entity, PoseStack pose, float partialTick) {
        pose.scale(1.5F, 1.5F, 1.5F);
    }

    @Override
    public ResourceLocation getTextureLocation(TankEntity entity) {
        return TEXTURE;
    }
}
