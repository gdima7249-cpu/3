package com.warfront.kingdom;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Проверка комнат как в Terraria: замкнутость, крыша, площадь, дверь, свет, кровати, территория. */
public final class HousingValidator {
    private static final int MAX_CELLS = 2500;
    private static final int RANGE_XZ = 14;
    private static final int RANGE_Y = 8;

    private HousingValidator() {
    }

    /** Возвращает null, если часть комнаты не загружена и проверить нельзя. */
    public static KingdomData.Building validate(ServerLevel level, BlockPos marker, BuildingType type, KingdomData d) {
        KingdomData.Building b = new KingdomData.Building();
        b.type = type;
        List<String> problems = new ArrayList<>();
        if (!d.inTerritory(marker)) {
            problems.add("вне территории (до " + KingdomData.TERRITORY_RADIUS + " блоков от штаба или своего форпоста)");
        }
        if (type.room) {
            if (!scanRoom(level, marker, type, b, problems)) return null;
        } else if (!scanField(level, marker, type, b, problems)) {
            return null;
        }
        b.valid = problems.isEmpty();
        b.capacity = b.valid ? Math.min(b.beds, type.maxBeds) : 0;
        if (b.valid) {
            b.text = type.room ? "комната " + b.area + " клеток" + (type.maxBeds > 0 ? ", кроватей " + b.beds + ", вмещает " + b.capacity : "")
                    : "грядок " + b.area;
        } else {
            b.text = String.join("; ", problems);
        }
        return b;
    }

    private static boolean passable(ServerLevel level, BlockPos pos) {
        BlockState s = level.getBlockState(pos);
        return s.getCollisionShape(level, pos).isEmpty() && s.getFluidState().isEmpty() && !(s.getBlock() instanceof DoorBlock);
    }

    private static boolean scanField(ServerLevel level, BlockPos marker, BuildingType type,
                                     KingdomData.Building b, List<String> problems) {
        for (int dx = -7; dx <= 7; dx += 7) {
            for (int dz = -7; dz <= 7; dz += 7) {
                if (!level.isLoaded(marker.offset(dx, 0, dz))) return false;
            }
        }
        int count = 0;
        for (int dx = -7; dx <= 7; dx++) {
            for (int dz = -7; dz <= 7; dz++) {
                for (int dy = -2; dy <= 2; dy++) {
                    if (level.getBlockState(marker.offset(dx, dy, dz)).is(Blocks.FARMLAND)) count++;
                }
            }
        }
        b.area = count;
        if (count < type.minArea) problems.add("мало грядок: " + count + " из " + type.minArea + " (вспаши землю мотыгой)");
        return true;
    }

    private static boolean scanRoom(ServerLevel level, BlockPos marker, BuildingType type,
                                    KingdomData.Building b, List<String> problems) {
        for (int dx = -RANGE_XZ; dx <= RANGE_XZ; dx += RANGE_XZ) {
            for (int dz = -RANGE_XZ; dz <= RANGE_XZ; dz += RANGE_XZ) {
                if (!level.isLoaded(marker.offset(dx, 0, dz))) return false;
            }
        }
        BlockPos start = null;
        for (Direction dir : Direction.values()) {
            BlockPos n = marker.relative(dir);
            if (passable(level, n)) {
                start = n;
                break;
            }
        }
        if (start == null) {
            problems.add("рядом с маркером нет свободного места - поставь его внутри комнаты");
            return true;
        }

        ArrayDeque<BlockPos> queue = new ArrayDeque<>();
        Set<Long> seen = new HashSet<>();
        Set<Long> columns = new HashSet<>();
        Set<Long> beds = new HashSet<>();
        Set<Long> doors = new HashSet<>();
        queue.add(start);
        seen.add(start.asLong());
        int cells = 0;
        int lights = 0;
        boolean leak = false;
        boolean sky = false;
        while (!queue.isEmpty()) {
            BlockPos pos = queue.poll();
            cells++;
            if (cells > MAX_CELLS) {
                leak = true;
                break;
            }
            BlockState here = level.getBlockState(pos);
            if (here.getLightEmission() > 0) lights++;
            if (level.canSeeSky(pos)) sky = true;
            columns.add(((long) pos.getX() << 32) ^ (pos.getZ() & 0xFFFFFFFFL));
            for (Direction dir : Direction.values()) {
                BlockPos n = pos.relative(dir);
                if (seen.contains(n.asLong())) continue;
                if (Math.abs(n.getX() - start.getX()) > RANGE_XZ || Math.abs(n.getZ() - start.getZ()) > RANGE_XZ
                        || Math.abs(n.getY() - start.getY()) > RANGE_Y) {
                    leak = true;
                    continue;
                }
                BlockState bs = level.getBlockState(n);
                if (passable(level, n)) {
                    seen.add(n.asLong());
                    queue.add(n);
                } else {
                    if (bs.getBlock() instanceof BedBlock) {
                        BlockPos head = bs.getValue(BedBlock.PART) == BedPart.HEAD ? n : n.relative(bs.getValue(BedBlock.FACING));
                        beds.add(head.asLong());
                    } else if (bs.getBlock() instanceof DoorBlock && bs.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER) {
                        doors.add(n.asLong());
                    } else if (bs.getBlock() instanceof DoorBlock) {
                        doors.add(n.below().asLong());
                    }
                    if (bs.getLightEmission() > 0) lights++;
                }
            }
        }

        b.area = columns.size();
        b.beds = beds.size();
        if (leak) problems.add("комната не замкнута (дыра в стене или слишком большая)");
        if (sky) problems.add("нет крыши (виднеется небо)");
        if (!leak && b.area < type.minArea) {
            problems.add("мало места: " + b.area + " из " + type.minArea + " клеток (нужно от " + side(type.minArea) + "x" + side(type.minArea) + ")");
        }
        if (!leak && cells < b.area * 2) problems.add("низкий потолок (нужно минимум 2 блока высоты)");
        if (doors.isEmpty()) problems.add("нет двери");
        if (lights == 0) problems.add("нет света (поставь факел)");
        if (b.beds < type.minBeds) problems.add("нужно кроватей: " + type.minBeds + " (есть " + b.beds + ")");
        return true;
    }

    private static int side(int area) {
        return (int) Math.round(Math.sqrt(area));
    }
}
