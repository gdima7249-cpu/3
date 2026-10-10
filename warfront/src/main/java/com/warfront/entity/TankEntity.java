package com.warfront.entity;

import com.warfront.ModEntities;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

import javax.annotation.Nullable;

/**
 * Танк. С игроком внутри - управляется WASD, пушка стреляет по клавише R.
 * Без экипажа - ездит по приказам отряда и сам бьёт по врагам из пушки.
 */
public class TankEntity extends SoldierEntity {
    private int cannonCooldown;

    public TankEntity(EntityType<? extends TankEntity> type, Level level) {
        super(type, level);
        setMaxUpStep(1.1F);
    }

    public static AttributeSupplier.Builder createTankAttributes() {
        return Mob.createMobAttributes()
                .add(Attributes.MAX_HEALTH, 160.0)
                .add(Attributes.MOVEMENT_SPEED, 0.2)
                .add(Attributes.FOLLOW_RANGE, 48.0)
                .add(Attributes.ARMOR, 10.0)
                .add(Attributes.KNOCKBACK_RESISTANCE, 1.0);
    }

    @Override
    protected int attackInterval() {
        return 70;
    }

    @Override
    protected double attackRange() {
        return 34.0;
    }

    @Override
    public void tick() {
        super.tick();
        if (cannonCooldown > 0) cannonCooldown--;
    }

    @Override
    public void performRangedAttack(LivingEntity target, float power) {
        Vec3 dir = new Vec3(target.getX() - getX(), target.getY(0.5) - (getY() + 1.8), target.getZ() - getZ());
        fire(dir);
    }

    /** Выстрел из пушки в заданном направлении. Возвращает false, если пушка перезаряжается. */
    public boolean fire(Vec3 direction) {
        if (cannonCooldown > 0 || level().isClientSide) return false;
        cannonCooldown = 50;
        Vec3 d = direction.normalize();
        RocketEntity shell = new RocketEntity(level(), this);
        shell.power = 3.0F;
        shell.setPos(getX() + d.x * 2.4, getY() + 1.8 + d.y * 2.4, getZ() + d.z * 2.4);
        shell.shoot(d.x, d.y, d.z, 2.6F, 0.4F);
        level().addFreshEntity(shell);
        playSound(SoundEvents.GENERIC_EXPLODE, 1.2F, 1.6F);
        return true;
    }

    // ---------- управление ----------

    @Nullable
    @Override
    public LivingEntity getControllingPassenger() {
        return getFirstPassenger() instanceof Player p ? p : null;
    }

    @Override
    protected boolean canAddPassenger(Entity passenger) {
        return getPassengers().isEmpty();
    }

    @Override
    public double getPassengersRidingOffset() {
        return 1.45;
    }

    @Override
    public void travel(Vec3 travel) {
        LivingEntity rider = getControllingPassenger();
        if (isVehicle() && rider instanceof Player p) {
            float target = p.getYRot();
            setYRot(Mth.approachDegrees(getYRot(), target, 5.0F));
            yRotO = getYRot();
            setXRot(Mth.clamp(p.getXRot(), -10.0F, 25.0F));
            yBodyRot = getYRot();
            yHeadRot = getYRot();
            float forward = p.zza;
            if (forward < 0) forward *= 0.5F;
            setSpeed((float) getAttributeValue(Attributes.MOVEMENT_SPEED));
            super.travel(new Vec3(0.0, travel.y, forward));
        } else {
            super.travel(travel);
        }
    }

    @Override
    protected InteractionResult mobInteract(Player player, InteractionHand hand) {
        if (!isEnemy() && !player.isSecondaryUseActive()) {
            if (!level().isClientSide) player.startRiding(this);
            return InteractionResult.sidedSuccess(level().isClientSide);
        }
        return InteractionResult.PASS;
    }

    public static TankEntity spawn(ServerLevel level, BlockPos near, int squad) {
        TankEntity t = ModEntities.TANK.get().create(level);
        if (t == null) return null;
        place(level, t, near);
        t.setSquad(squad);
        t.setEnemy(false);
        level.addFreshEntity(t);
        return t;
    }
}
