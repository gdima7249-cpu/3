package com.warfront;

import com.warfront.block.BuildingBlock;
import com.warfront.block.EnemyFlagBlock;
import com.warfront.block.HeadquartersBlock;
import com.warfront.kingdom.BuildingType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

import java.util.EnumMap;
import java.util.Map;

public final class ModBlocks {
    public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, Warfront.ID);

    public static final RegistryObject<Block> HQ = BLOCKS.register("headquarters",
            () -> new HeadquartersBlock(BlockBehaviour.Properties.of().mapColor(MapColor.COLOR_RED)
                    .strength(5f, 12f).sound(SoundType.METAL).noOcclusion()));

    public static final RegistryObject<Block> ENEMY_FLAG = BLOCKS.register("enemy_flag",
            () -> new EnemyFlagBlock(BlockBehaviour.Properties.of().mapColor(MapColor.COLOR_BLACK)
                    .strength(-1f, 3600000f).sound(SoundType.WOOL).noLootTable().noOcclusion()));

    public static final Map<BuildingType, RegistryObject<Block>> BUILDINGS = new EnumMap<>(BuildingType.class);

    static {
        for (BuildingType t : BuildingType.values()) {
            BUILDINGS.put(t, BLOCKS.register(t.id,
                    () -> new BuildingBlock(t, BlockBehaviour.Properties.of().mapColor(MapColor.STONE)
                            .strength(3f, 6f).sound(SoundType.STONE).noOcclusion())));
        }
    }

    private ModBlocks() {
    }
}
