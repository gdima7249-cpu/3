package com.warfront.client;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.material.MapColor;

import java.util.HashMap;
import java.util.Map;

/** Память карты: цвета местности по чанкам запоминаются, пока игра запущена. */
public final class TerrainCache {
    public static final int UNKNOWN = 0xFF26262C;
    private static final Map<Long, int[]> CHUNKS = new HashMap<>();
    private static final Map<Long, Long> STAMPS = new HashMap<>();
    private static ClientLevel owner;

    private TerrainCache() {
    }

    private static long key(int cx, int cz) {
        return ((long) cx << 32) ^ (cz & 0xFFFFFFFFL);
    }

    /** Просканировать загруженные чанки вокруг центра; не больше budget за вызов. */
    public static void scan(ClientLevel level, int ccx, int ccz, int radius, int budget) {
        if (owner != level) {
            CHUNKS.clear();
            STAMPS.clear();
            owner = level;
        }
        long now = level.getGameTime();
        int done = 0;
        for (int r = 0; r <= radius && done < budget; r++) {
            for (int dx = -r; dx <= r && done < budget; dx++) {
                for (int dz = -r; dz <= r && done < budget; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != r) continue;
                    int cx = ccx + dx, cz = ccz + dz;
                    if (!level.getChunkSource().hasChunk(cx, cz)) continue;
                    long k = key(cx, cz);
                    Long stamp = STAMPS.get(k);
                    if (stamp != null && now - stamp < 400) continue;
                    CHUNKS.put(k, compute(level, cx, cz));
                    STAMPS.put(k, now);
                    done++;
                }
            }
        }
    }

    private static int[] compute(ClientLevel level, int cx, int cz) {
        int[] out = new int[256];
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        for (int lx = 0; lx < 16; lx++) {
            for (int lz = 0; lz < 16; lz++) {
                int wx = cx * 16 + lx, wz = cz * 16 + lz;
                int h = level.getHeight(Heightmap.Types.WORLD_SURFACE, wx, wz);
                pos.set(wx, h - 1, wz);
                BlockState state = level.getBlockState(pos);
                MapColor mc = state.getMapColor(level, pos);
                int rgb = mc.col;
                if (rgb == 0) {
                    out[lz * 16 + lx] = UNKNOWN;
                    continue;
                }
                int hn = h;
                if (level.getChunkSource().hasChunk(wx >> 4, (wz - 1) >> 4)) {
                    hn = level.getHeight(Heightmap.Types.WORLD_SURFACE, wx, wz - 1);
                }
                float f = h > hn ? 1.14F : h < hn ? 0.8F : 1.0F;
                int r = Math.min(255, (int) (((rgb >> 16) & 255) * f));
                int g = Math.min(255, (int) (((rgb >> 8) & 255) * f));
                int b = Math.min(255, (int) ((rgb & 255) * f));
                out[lz * 16 + lx] = 0xFF000000 | (b << 16) | (g << 8) | r; // ABGR для NativeImage
            }
        }
        return out;
    }

    /** Цвет точки мира в формате ABGR. */
    public static int color(int wx, int wz) {
        int[] c = CHUNKS.get(key(wx >> 4, wz >> 4));
        return c == null ? UNKNOWN : c[(wz & 15) * 16 + (wx & 15)];
    }
}
