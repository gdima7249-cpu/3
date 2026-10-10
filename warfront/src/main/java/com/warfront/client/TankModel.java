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

/** Модель танка: корпус, гусеницы с катками, лобовая плита, башня с люком, ствол с дульным тормозом, антенна. */
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
        PartPose ground = PartPose.offset(0.0F, 24.0F, 0.0F);

        r.addOrReplaceChild("hull", CubeListBuilder.create().texOffs(0, 0)
                .addBox(-10.0F, -13.0F, -16.0F, 20.0F, 7.0F, 32.0F), ground);
        r.addOrReplaceChild("glacis", CubeListBuilder.create().texOffs(0, 0)
                .addBox(-10.0F, -11.0F, -21.0F, 20.0F, 5.0F, 5.0F), ground);
        r.addOrReplaceChild("deck", CubeListBuilder.create().texOffs(0, 0)
                .addBox(-8.0F, -15.0F, 7.0F, 16.0F, 2.0F, 8.0F), ground);
        r.addOrReplaceChild("track_l", CubeListBuilder.create().texOffs(0, 40)
                .addBox(-15.0F, -7.0F, -18.0F, 5.0F, 7.0F, 36.0F), ground);
        r.addOrReplaceChild("track_r", CubeListBuilder.create().texOffs(0, 40)
                .addBox(10.0F, -7.0F, -18.0F, 5.0F, 7.0F, 36.0F), ground);
        for (int i = 0; i < 5; i++) {
            float z = -14.0F + i * 7.0F;
            r.addOrReplaceChild("wheel_l" + i, CubeListBuilder.create().texOffs(0, 40)
                    .addBox(-16.5F, -6.0F, z - 2.5F, 1.5F, 5.0F, 5.0F), ground);
            r.addOrReplaceChild("wheel_r" + i, CubeListBuilder.create().texOffs(0, 40)
                    .addBox(15.0F, -6.0F, z - 2.5F, 1.5F, 5.0F, 5.0F), ground);
        }
        r.addOrReplaceChild("fender_l", CubeListBuilder.create().texOffs(0, 0)
                .addBox(-15.0F, -8.0F, -18.0F, 6.0F, 1.0F, 36.0F), ground);
        r.addOrReplaceChild("fender_r", CubeListBuilder.create().texOffs(0, 0)
                .addBox(9.0F, -8.0F, -18.0F, 6.0F, 1.0F, 36.0F), ground);

        PartDefinition turret = r.addOrReplaceChild("turret", CubeListBuilder.create().texOffs(0, 90)
                .addBox(-8.0F, -7.0F, -9.0F, 16.0F, 7.0F, 18.0F), PartPose.offset(0.0F, 11.0F, 1.0F));
        turret.addOrReplaceChild("cupola", CubeListBuilder.create().texOffs(0, 90)
                .addBox(-3.0F, -3.0F, 0.0F, 6.0F, 3.0F, 6.0F), PartPose.offset(3.0F, -7.0F, 1.0F));
        turret.addOrReplaceChild("antenna", CubeListBuilder.create().texOffs(0, 90)
                .addBox(-0.5F, -14.0F, -0.5F, 1.0F, 14.0F, 1.0F), PartPose.offset(-5.0F, -7.0F, 7.0F));
        PartDefinition barrel = turret.addOrReplaceChild("barrel", CubeListBuilder.create().texOffs(70, 90)
                .addBox(-1.5F, -1.5F, -24.0F, 3.0F, 3.0F, 24.0F), PartPose.offset(0.0F, -3.5F, -9.0F));
        barrel.addOrReplaceChild("muzzle", CubeListBuilder.create().texOffs(70, 90)
                .addBox(-2.5F, -2.5F, -4.0F, 5.0F, 5.0F, 4.0F), PartPose.offset(0.0F, 0.0F, -24.0F));
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
