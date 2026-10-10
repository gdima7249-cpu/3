package com.warfront.entity;

import com.warfront.ModEntities;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.HitResult;

/** Ракета и танковый снаряд: взрывается при попадании. */
public class RocketEntity extends BulletEntity {
    public float power = 2.5f;

    public RocketEntity(EntityType<? extends RocketEntity> type, Level level) {
        super(type, level);
        maxLife = 120;
    }

    public RocketEntity(Level level, LivingEntity owner) {
        super(ModEntities.ROCKET.get(), level, owner);
        maxLife = 120;
    }

    @Override
    public void tick() {
        super.tick();
        if (level().isClientSide) {
            level().addParticle(ParticleTypes.SMOKE, getX(), getY(), getZ(), 0, 0, 0);
        }
    }

    @Override
    protected void onHit(HitResult hit) {
        if (level().isClientSide) return;
        Level.ExplosionInteraction mode = Level.ExplosionInteraction.MOB;
        if (level().getServer() != null && !(getOwner() instanceof SoldierEntity s && s.isEnemy())) {
            com.warfront.kingdom.KingdomData d = com.warfront.kingdom.KingdomData.get(level().getServer());
            // своя артиллерия не рушит базу: на территории королевства взрыв только бьёт по врагам
            if (d.founded && d.inTerritory(blockPosition())) mode = Level.ExplosionInteraction.NONE;
        }
        level().explode(this, getX(), getY(), getZ(), power, mode);
        discard();
    }
}
