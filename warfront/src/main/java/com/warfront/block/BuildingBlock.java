package com.warfront.block;

import com.warfront.kingdom.BuildingType;
import com.warfront.kingdom.KingdomData;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/** Здание королевства: при установке попадает в учёт, при разрушении выбывает. */
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
            d.buildings.put(pos.asLong(), type);
            d.setDirty();
        }
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
