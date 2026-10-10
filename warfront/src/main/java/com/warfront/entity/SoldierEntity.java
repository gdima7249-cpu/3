package com.warfront.entity;

import com.warfront.ModEntities;
import com.warfront.ModItems;
import com.warfront.ModTags;
import com.warfront.item.GunItem;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.goal.FloatGoal;
import net.minecraft.world.entity.ai.goal.Goal;
import net.minecraft.world.entity.ai.goal.LookAtPlayerGoal;
import net.minecraft.world.entity.ai.goal.RandomLookAroundGoal;
import net.minecraft.world.entity.ai.goal.target.HurtByTargetGoal;
import net.minecraft.world.entity.ai.goal.target.NearestAttackableTargetGoal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.RangedAttackMob;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

import java.util.EnumSet;

/** Солдат: выполняет приказы отряда, стреляет, воюет за игрока или за врага. */
public class SoldierEntity extends PathfinderMob implements RangedAttackMob {
    public static final int NONE = 0, MOVE = 1, ATTACK = 2, DEFEND = 3;
    private static final EntityDataAccessor<Integer> SQUAD =
            SynchedEntityData.defineId(SoldierEntity.class, EntityDataSerializers.INT);
    private static final EntityDataAccessor<Boolean> ENEMY =
            SynchedEntityData.defineId(SoldierEntity.class, EntityDataSerializers.BOOLEAN);

    public int order = NONE;
    public BlockPos orderPos = null;
    protected int attackCooldown;

    public SoldierEntity(EntityType<? extends SoldierEntity> type, Level level) {
        super(type, level);
        setPersistenceRequired();
    }

    public static AttributeSupplier.Builder createAttributes() {
        return Mob.createMobAttributes()
                .add(Attributes.MAX_HEALTH, 24.0)
                .add(Attributes.MOVEMENT_SPEED, 0.27)
                .add(Attributes.FOLLOW_RANGE, 40.0)
                .add(Attributes.ARMOR, 2.0);
    }

    @Override
    protected void defineSynchedData() {
        super.defineSynchedData();
        entityData.define(SQUAD, 1);
        entityData.define(ENEMY, false);
    }

    public int getSquad() {
        return entityData.get(SQUAD);
    }

    public void setSquad(int squad) {
        entityData.set(SQUAD, squad);
        refreshLabel();
    }

    /** Подпись над головой: номер отряда (у врагов подписи нет). */
    public void refreshLabel() {
        if (isEnemy()) {
            setCustomName(null);
            setCustomNameVisible(false);
        } else {
            setCustomName(net.minecraft.network.chat.Component.literal((this instanceof TankEntity ? "Танк " : "Отряд ") + getSquad()));
            setCustomNameVisible(true);
        }
    }

    public boolean isEnemy() {
        return entityData.get(ENEMY);
    }

    public void setEnemy(boolean enemy) {
        entityData.set(ENEMY, enemy);
        refreshLabel();
    }

    public void giveOrder(int type, BlockPos pos) {
        this.order = type;
        this.orderPos = pos;
        getNavigation().stop();
    }

    // ---------- ИИ ----------

    @Override
    protected void registerGoals() {
        goalSelector.addGoal(0, new FloatGoal(this));
        goalSelector.addGoal(1, new AttackGoal(this));
        goalSelector.addGoal(2, new OrderGoal(this));
        goalSelector.addGoal(6, new LookAtPlayerGoal(this, Player.class, 8.0F));
        goalSelector.addGoal(7, new RandomLookAroundGoal(this));
        targetSelector.addGoal(1, new HurtByTargetGoal(this));
        targetSelector.addGoal(2, new NearestAttackableTargetGoal<>(this, LivingEntity.class, 10, true, false,
                this::isHostileTo));
    }

    public boolean isHostileTo(LivingEntity e) {
        if (e == this || !e.isAlive()) return false;
        if (isEnemy()) {
            if (e instanceof Player p) return !p.isCreative() && !p.isSpectator();
            return e instanceof SoldierEntity s && !s.isEnemy();
        }
        if (e instanceof SoldierEntity s) return s.isEnemy();
        return e instanceof Enemy;
    }

    @Override
    public void setTarget(LivingEntity target) {
        if (!isEnemy() && target instanceof Player) return;
        if (target instanceof SoldierEntity s && s.isEnemy() == isEnemy()) return;
        super.setTarget(target);
    }

    public boolean hasRider() {
        return isVehicle();
    }

    protected int attackInterval() {
        return 22;
    }

    protected double attackRange() {
        return 26.0;
    }

    /** Приказ MOVE игнорирует врагов, пока отряд не дойдёт. */
    static final class AttackGoal extends Goal {
        private final SoldierEntity m;

        AttackGoal(SoldierEntity m) {
            this.m = m;
            setFlags(EnumSet.of(Flag.MOVE, Flag.LOOK));
        }

        @Override
        public boolean canUse() {
            LivingEntity t = m.getTarget();
            if (t == null || !t.isAlive() || m.hasRider() || m.order == MOVE) return false;
            if (m.order == DEFEND && m.orderPos != null && m.orderPos.distSqr(m.blockPosition()) > 18 * 18) return false;
            return true;
        }

        @Override
        public boolean canContinueToUse() {
            return canUse();
        }

        @Override
        public void start() {
            m.setAggressive(true);
        }

        @Override
        public void stop() {
            m.setAggressive(false);
        }

        @Override
        public void tick() {
            LivingEntity t = m.getTarget();
            if (t == null) return;
            double d2 = m.distanceToSqr(t);
            boolean sees = m.getSensing().hasLineOfSight(t);
            double range = m.attackRange();
            if (d2 > range * range || !sees) {
                m.getNavigation().moveTo(t, 1.0);
            } else {
                m.getNavigation().stop();
            }
            m.getLookControl().setLookAt(t, 30.0F, 30.0F);
            if (m.attackCooldown > 0) m.attackCooldown--;
            if (m.attackCooldown <= 0 && sees && d2 <= range * range) {
                m.performRangedAttack(t, 1.0F);
                m.attackCooldown = m.attackInterval();
            }
        }
    }

    static final class OrderGoal extends Goal {
        private final SoldierEntity m;
        private int repath;

        OrderGoal(SoldierEntity m) {
            this.m = m;
            setFlags(EnumSet.of(Flag.MOVE));
        }

        @Override
        public boolean canUse() {
            return m.order != NONE && m.orderPos != null && !m.hasRider();
        }

        @Override
        public void tick() {
            BlockPos p = m.orderPos;
            double d2 = m.distanceToSqr(p.getX() + 0.5, p.getY(), p.getZ() + 0.5);
            switch (m.order) {
                case MOVE -> {
                    if (d2 < 16) {
                        m.order = DEFEND;
                        m.getNavigation().stop();
                        return;
                    }
                    go(p);
                }
                case ATTACK -> {
                    if (d2 < 36) {
                        m.order = DEFEND;
                        m.getNavigation().stop();
                        return;
                    }
                    go(p);
                }
                case DEFEND -> {
                    if (d2 > 49) go(p);
                    else m.getNavigation().stop();
                }
                default -> { }
            }
        }

        private void go(BlockPos p) {
            if (--repath <= 0 || m.getNavigation().isDone()) {
                repath = 20;
                m.getNavigation().moveTo(p.getX() + 0.5, p.getY(), p.getZ() + 0.5, 1.15);
            }
        }
    }

    // ---------- стрельба ----------

    public float weaponDamage() {
        ItemStack held = getMainHandItem();
        if (held.getItem() instanceof GunItem g) return g.damage;
        if (held.is(ModTags.SOLDIER_WEAPONS)) return 6.0F;
        return 2.5F;
    }

    @Override
    public void performRangedAttack(LivingEntity target, float power) {
        BulletEntity b = new BulletEntity(level(), this);
        double dx = target.getX() - getX();
        double dy = target.getY(0.5) - b.getY();
        double dz = target.getZ() - getZ();
        float speed = 3.2F;
        b.shoot(dx, dy, dz, speed, 2.5F);
        b.setBaseDamage(weaponDamage() / speed);
        level().addFreshEntity(b);
        playSound(SoundEvents.ARROW_SHOOT, 0.9F, 1.6F);
    }

    // ---------- взаимодействие ----------

    @Override
    protected InteractionResult mobInteract(Player player, InteractionHand hand) {
        ItemStack stack = player.getItemInHand(hand);
        if (!isEnemy() && !stack.isEmpty() && (stack.getItem() instanceof GunItem || stack.is(ModTags.SOLDIER_WEAPONS))) {
            if (!level().isClientSide) {
                ItemStack old = getMainHandItem();
                ItemStack one = stack.copy();
                one.setCount(1);
                setItemSlot(EquipmentSlot.MAINHAND, one);
                stack.shrink(1);
                if (!old.isEmpty() && !player.getInventory().add(old)) player.drop(old, false);
                playSound(SoundEvents.ARMOR_EQUIP_IRON, 1.0F, 1.0F);
            }
            return InteractionResult.sidedSuccess(level().isClientSide);
        }
        return super.mobInteract(player, hand);
    }

    @Override
    public boolean removeWhenFarAway(double distance) {
        return false;
    }

    // ---------- сохранение ----------

    @Override
    public void addAdditionalSaveData(CompoundTag tag) {
        super.addAdditionalSaveData(tag);
        tag.putInt("Squad", getSquad());
        tag.putBoolean("Enemy", isEnemy());
        tag.putInt("Order", order);
        if (orderPos != null) tag.putLong("OrderPos", orderPos.asLong());
    }

    @Override
    public void readAdditionalSaveData(CompoundTag tag) {
        super.readAdditionalSaveData(tag);
        setSquad(Math.max(1, tag.getInt("Squad")));
        setEnemy(tag.getBoolean("Enemy"));
        refreshLabel();
        order = tag.getInt("Order");
        orderPos = tag.contains("OrderPos") ? BlockPos.of(tag.getLong("OrderPos")) : null;
    }

    // ---------- создание ----------

    public static SoldierEntity spawn(ServerLevel level, BlockPos near, int squad, boolean enemy) {
        SoldierEntity s = ModEntities.SOLDIER.get().create(level);
        if (s == null) return null;
        place(level, s, near);
        s.setSquad(squad);
        s.setEnemy(enemy);
        s.setItemSlot(EquipmentSlot.MAINHAND, new ItemStack(ModItems.RIFLE.get()));
        s.setItemSlot(EquipmentSlot.HEAD, new ItemStack(net.minecraft.world.item.Items.IRON_HELMET));
        s.setItemSlot(EquipmentSlot.CHEST, new ItemStack(enemy ? net.minecraft.world.item.Items.LEATHER_CHESTPLATE
                : net.minecraft.world.item.Items.IRON_CHESTPLATE));
        s.setItemSlot(EquipmentSlot.LEGS, new ItemStack(enemy ? net.minecraft.world.item.Items.LEATHER_LEGGINGS
                : net.minecraft.world.item.Items.CHAINMAIL_LEGGINGS));
        s.setItemSlot(EquipmentSlot.FEET, new ItemStack(enemy ? net.minecraft.world.item.Items.LEATHER_BOOTS
                : net.minecraft.world.item.Items.CHAINMAIL_BOOTS));
        for (EquipmentSlot slot : EquipmentSlot.values()) s.setDropChance(slot, 0.0F);
        level.addFreshEntity(s);
        return s;
    }

    protected static void place(ServerLevel level, Mob mob, BlockPos near) {
        int x = near.getX() + level.random.nextInt(5) - 2;
        int z = near.getZ() + level.random.nextInt(5) - 2;
        int y = near.getY();
        BlockPos p = new BlockPos(x, y, z);
        for (int i = 0; i < 6 && !level.getBlockState(p).isAir(); i++) p = p.above();
        Vec3 v = Vec3.atBottomCenterOf(p);
        mob.moveTo(v.x, v.y, v.z, level.random.nextFloat() * 360.0F, 0.0F);
    }

    @Override
    public boolean hurt(DamageSource source, float amount) {
        return super.hurt(source, amount);
    }
}
