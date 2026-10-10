package com.warfront.block;

import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomManager;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;

/** Штаб. Первая установка основывает королевство. ПКМ предметом - сдать припасы на склад. */
public class HeadquartersBlock extends Block {
    public HeadquartersBlock(Properties props) {
        super(props);
    }

    @Override
    public void onPlace(BlockState state, Level level, BlockPos pos, BlockState oldState, boolean isMoving) {
        super.onPlace(state, level, pos, oldState, isMoving);
        if (level instanceof ServerLevel sl && !oldState.is(this)) {
            KingdomData d = KingdomData.get(sl.getServer());
            if (!d.founded) KingdomManager.found(sl, pos);
        }
    }

    @Override
    public InteractionResult use(BlockState state, Level level, BlockPos pos, Player player,
                                 InteractionHand hand, BlockHitResult hit) {
        if (level.isClientSide) return InteractionResult.SUCCESS;
        ServerPlayer sp = (ServerPlayer) player;
        KingdomData d = KingdomData.get(sp.server);
        ItemStack held = player.getItemInHand(hand);
        int n = held.getCount();
        if (!held.isEmpty()) {
            if (held.is(Items.IRON_INGOT)) {
                d.iron += n;
            } else if (held.is(Items.GUNPOWDER)) {
                d.ammo += n * 2;
            } else if (held.is(Items.ARROW)) {
                d.ammo += n;
            } else if (held.is(Items.BREAD) || held.is(Items.COOKED_BEEF) || held.is(Items.COOKED_PORKCHOP)
                    || held.is(Items.COOKED_CHICKEN) || held.is(Items.CARROT) || held.is(Items.POTATO)
                    || held.is(Items.WHEAT)) {
                d.food += n * 3;
            } else {
                player.displayClientMessage(Component.literal(
                        "Склад принимает: железо, порох, стрелы, еду. Командуй картой - планшетом."), true);
                return InteractionResult.CONSUME;
            }
            held.shrink(n);
            d.setDirty();
            player.displayClientMessage(Component.literal("Припасы сданы на склад. Еда " + d.food + ", железо "
                    + d.iron + ", боеприпасы " + d.ammo), true);
            return InteractionResult.CONSUME;
        }
        player.displayClientMessage(Component.literal("Штаб: население " + d.pop + "/" + d.capacity() + ", еда " + d.food
                + ", железо " + d.iron + ", боеприпасы " + d.ammo + ". Планшет открывает карту."), false);
        return InteractionResult.CONSUME;
    }
}
