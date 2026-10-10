package com.warfront.block;

import com.warfront.kingdom.BuildingType;
import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomManager;
import com.warfront.net.Net;
import com.warfront.net.NotifyPacket;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraftforge.network.PacketDistributor;

import javax.annotation.Nullable;

/**
 * Знак здания. Ставится внутри построенной комнаты: проверяется площадь, крыша, дверь, свет, кровати.
 * ПКМ по знаку - проверить заново.
 */
public class BuildingBlock extends Block {
    public final BuildingType type;

    public BuildingBlock(BuildingType type, Properties props) {
        super(props);
        this.type = type;
    }

    @Override
    public void onPlace(BlockState state, Level level, BlockPos pos, BlockState oldState, boolean isMoving) {
        super.onPlace(state, level, pos, oldState, isMoving);
        if (level instanceof ServerLevel sl && !oldState.is(this)) {
            KingdomData d = KingdomData.get(sl.getServer());
            if (!d.founded) return;
            KingdomManager.check(sl, pos, type);
        }
    }

    @Override
    public void setPlacedBy(Level level, BlockPos pos, BlockState state, @Nullable LivingEntity placer, ItemStack stack) {
        super.setPlacedBy(level, pos, state, placer, stack);
        if (level instanceof ServerLevel sl && placer instanceof ServerPlayer sp) report(sl, pos, sp);
    }

    @Override
    public InteractionResult use(BlockState state, Level level, BlockPos pos, Player player,
                                 InteractionHand hand, BlockHitResult hit) {
        if (level instanceof ServerLevel sl && player instanceof ServerPlayer sp) {
            if (!KingdomData.get(sl.getServer()).founded) {
                sp.displayClientMessage(net.minecraft.network.chat.Component.literal("Сначала поставь Штаб."), true);
            } else {
                KingdomManager.check(sl, pos, type);
                report(sl, pos, sp);
            }
        }
        return InteractionResult.sidedSuccess(level.isClientSide);
    }

    private void report(ServerLevel level, BlockPos pos, ServerPlayer player) {
        KingdomData d = KingdomData.get(level.getServer());
        KingdomData.Building b = d.buildings.get(pos.asLong());
        if (b == null) {
            player.displayClientMessage(net.minecraft.network.chat.Component.literal(
                    "Часть комнаты не загружена - подойди ближе."), true);
            return;
        }
        String title = (b.valid ? "Принято: " : "Не принято: ") + type.title;
        Net.CHANNEL.send(PacketDistributor.PLAYER.with(() -> player), new NotifyPacket(title, b.text, b.valid ? 0 : 1));
    }

    @Override
    public void onRemove(BlockState state, Level level, BlockPos pos, BlockState newState, boolean isMoving) {
        if (level instanceof ServerLevel sl && !newState.is(this)) {
            KingdomData d = KingdomData.get(sl.getServer());
            d.buildings.remove(pos.asLong());
            d.setDirty();
        }
        super.onRemove(state, level, pos, newState, isMoving);
    }
}
