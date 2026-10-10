package com.warfront.client;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.warfront.Warfront;
import com.warfront.entity.TankEntity;
import net.minecraft.client.model.EntityModel;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;

/** Простая модель танка из блоков: корпус, гусеницы, башня и ствол, который поднимается за взглядом. */
public class TankModel extends EntityModel<TankEntity> {
    public static final ModelLayerLocation LAYER =
            new ModelLayerLocation(new ResourceLocation(Warfront.ID, "tank"), "main");

    private final ModelPart root;
    private final ModelPart barrel;

    public TankModel(ModelPart root) {
        this.root = root;
        this.barrel = root.getChild("turret").getChild("barrel");
    }

    public static LayerDefinition createLayer() {
        MeshDefinition mesh = new MeshDefinition();
        PartDefinition r = mesh.getRoot();
        r.addOrReplaceChild("hull", CubeListBuilder.create().texOffs(0, 0)
                .addBox(-10.0F, -8.0F, -16.0F, 20.0F, 7.0F, 32.0F), PartPose.offset(0.0F, 22.0F, 0.0F));
        r.addOrReplaceChild("track_l", CubeListBuilder.create().texOffs(0, 40)
                .addBox(-14.0F, -6.0F, -17.0F, 5.0F, 6.0F, 34.0F), PartPose.offset(0.0F, 24.0F, 0.0F));
        r.addOrReplaceChild("track_r", CubeListBuilder.create().texOffs(0, 40)
                .addBox(9.0F, -6.0F, -17.0F, 5.0F, 6.0F, 34.0F), PartPose.offset(0.0F, 24.0F, 0.0F));
        PartDefinition turret = r.addOrReplaceChild("turret", CubeListBuilder.create().texOffs(0, 80)
                .addBox(-7.0F, -6.0F, -8.0F, 14.0F, 6.0F, 16.0F), PartPose.offset(0.0F, 14.0F, 2.0F));
        turret.addOrReplaceChild("barrel", CubeListBuilder.create().texOffs(60, 80)
                .addBox(-1.5F, -1.5F, -22.0F, 3.0F, 3.0F, 22.0F), PartPose.offset(0.0F, -3.0F, -6.0F));
        return LayerDefinition.create(mesh, 128, 128);
    }

    @Override
    public void setupAnim(TankEntity entity, float limbSwing, float limbSwingAmount, float ageInTicks,
                          float netHeadYaw, float headPitch) {
        barrel.xRot = headPitch * Mth.DEG_TO_RAD;
    }

    @Override
    public void renderToBuffer(PoseStack pose, VertexConsumer buffer, int light, int overlay,
                               float r, float g, float b, float a) {
        root.render(pose, buffer, light, overlay, r, g, b, a);
    }
}
