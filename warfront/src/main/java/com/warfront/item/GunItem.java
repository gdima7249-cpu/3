package com.warfront.item;

import com.warfront.ModItems;
import com.warfront.entity.BulletEntity;
import com.warfront.entity.RocketEntity;
import net.minecraft.network.chat.Component;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResultHolder;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.UseAnim;
import net.minecraft.world.level.Level;

/** Огнестрельное оружие игрока. Солдаты стреляют из него теми же характеристиками урона. */
public class GunItem extends Item {
    public final float damage;
    public final int interval;
    public final boolean auto;
    public final int pellets;
    public final float spread;
    public final float speed;
    public final boolean rocket;

    public GunItem(Properties props, float damage, int interval, boolean auto, int pellets, float spread,
                   float speed, boolean rocket) {
        super(props);
        this.damage = damage;
        this.interval = interval;
        this.auto = auto;
        this.pellets = pellets;
        this.spread = spread;
        this.speed = speed;
        this.rocket = rocket;
    }

    @Override
    public InteractionResultHolder<ItemStack> use(Level level, Player player, InteractionHand hand) {
        ItemStack stack = player.getItemInHand(hand);
        if (auto) {
            player.startUsingItem(hand);
            return InteractionResultHolder.consume(stack);
        }
        if (!level.isClientSide) tryFire(level, player);
        return InteractionResultHolder.sidedSuccess(stack, level.isClientSide);
    }

    @Override
    public void onUseTick(Level level, LivingEntity entity, ItemStack stack, int remaining) {
        if (!auto || level.isClientSide || !(entity instanceof Player player)) return;
        int used = getUseDuration(stack) - remaining;
        if (used % interval == 0) tryFire(level, player);
    }

    @Override
    public int getUseDuration(ItemStack stack) {
        return auto ? 72000 : 0;
    }

    @Override
    public UseAnim getUseAnimation(ItemStack stack) {
        return UseAnim.NONE;
    }

    private void tryFire(Level level, Player player) {
        if (!auto && player.getCooldowns().isOnCooldown(this)) return;
        Item ammo = rocket ? ModItems.ROCKET.get() : ModItems.AMMO.get();
        if (!player.getAbilities().instabuild && !consume(player.getInventory(), ammo)) {
            player.displayClientMessage(Component.literal(rocket ? "Нет ракет" : "Нет патронов"), true);
            return;
        }
        for (int i = 0; i < pellets; i++) {
            BulletEntity b = rocket ? new RocketEntity(level, player) : new BulletEntity(level, player);
            b.shootFromRotation(player, player.getXRot(), player.getYRot(), 0.0F, speed, spread);
            if (!rocket) b.setBaseDamage(damage / speed);
            level.addFreshEntity(b);
        }
        level.playSound(null, player.getX(), player.getY(), player.getZ(),
                rocket ? SoundEvents.FIREWORK_ROCKET_LAUNCH : SoundEvents.CROSSBOW_SHOOT,
                SoundSource.PLAYERS, 1.0F, rocket ? 0.8F : 1.5F);
        if (!auto) player.getCooldowns().addCooldown(this, interval);
    }

    private static boolean consume(Inventory inv, Item ammo) {
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (s.is(ammo)) {
                s.shrink(1);
                return true;
            }
        }
        return false;
    }
}
