package com.warfront.entity;

import com.warfront.ModEntities;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.BlockHitResult;

/** Пуля: быстрая, без гравитации, не подбирается. Не ранит своих. */
public class BulletEntity extends AbstractArrow {
    protected int maxLife = 50;

    public BulletEntity(EntityType<? extends BulletEntity> type, Level level) {
        super(type, level);
        init();
    }

    public BulletEntity(Level level, LivingEntity owner) {
        this(ModEntities.BULLET.get(), level, owner);
    }

    protected BulletEntity(EntityType<? extends BulletEntity> type, Level level, LivingEntity owner) {
        super(type, owner, level);
        init();
    }

    private void init() {
        setNoGravity(true);
        pickup = AbstractArrow.Pickup.DISALLOWED;
    }

    @Override
    protected ItemStack getPickupItem() {
        return ItemStack.EMPTY;
    }

    @Override
    public void tick() {
        super.tick();
        if (!level().isClientSide && tickCount > maxLife) discard();
    }

    @Override
    protected void onHitBlock(BlockHitResult hit) {
        if (!level().isClientSide) discard();
    }

    @Override
    protected boolean canHitEntity(Entity target) {
        Entity owner = getOwner();
        if (target instanceof SoldierEntity t && owner != null) {
            if (owner instanceof SoldierEntity o) {
                if (o.isEnemy() == t.isEnemy()) return false;
            } else if (!t.isEnemy()) {
                return false;
            }
        }
        return super.canHitEntity(target);
    }
}
