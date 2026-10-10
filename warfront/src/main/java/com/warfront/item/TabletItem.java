package com.warfront.item;

import com.warfront.kingdom.KingdomData;
import com.warfront.net.Net;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResultHolder;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;

/** Командирский планшет: открывает карту мира с приказами. */
public class TabletItem extends Item {
    public TabletItem(Properties props) {
        super(props);
    }

    @Override
    public InteractionResultHolder<ItemStack> use(Level level, Player player, InteractionHand hand) {
        ItemStack stack = player.getItemInHand(hand);
        if (!level.isClientSide && player instanceof ServerPlayer sp) {
            if (!KingdomData.get(sp.server).founded) {
                sp.displayClientMessage(Component.literal(
                        "Сначала поставь Штаб - им основывается твоё королевство."), true);
            } else {
                Net.sendSync(sp, true);
            }
        }
        return InteractionResultHolder.sidedSuccess(stack, level.isClientSide);
    }
}
