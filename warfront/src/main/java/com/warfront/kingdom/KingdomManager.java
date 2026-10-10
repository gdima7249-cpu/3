package com.warfront.kingdom;

import com.warfront.ModBlocks;
import com.warfront.block.BuildingBlock;
import com.warfront.entity.SoldierEntity;
import com.warfront.entity.TankEntity;
import com.warfront.net.Net;
import com.warfront.net.HudPacket;
import com.warfront.net.NotifyPacket;
import com.warfront.ModItems;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraftforge.network.PacketDistributor;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.AABB;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/** Игровой цикл королевства: население, экономика, налёты, форпосты, приказы. */
public final class KingdomManager {
    public static final int TURN_TICKS = 600;

    private KingdomManager() {
    }

    // ---------- основание ----------

    public static void found(ServerLevel level, BlockPos pos) {
        KingdomData d = KingdomData.get(level.getServer());
        d.founded = true;
        d.hq = pos;
        d.pop = 6;
        d.food = 120;
        d.iron = 80;
        d.ammo = 80;
        d.lastTurn = level.getGameTime();
        d.nextRaid = level.getGameTime() + 9000;
        for (int i = 0; i < 4; i++) SoldierEntity.spawn(level, pos.above(), 1, false);
        ensureOutposts(level, d);
        if (!d.outposts.isEmpty()) d.outposts.get(0).discovered = true;
        d.setDirty();
        notify(level.getServer(), "Королевство основано",
                "Построй комнаты с кроватью, дверью и светом, поставь в них знак здания. Карта: клавиша M.", 0);
    }

    /** Событие для игрока: всплывающее уведомление + запись в журнал. kind: 0 - обычное, 1 - тревога. */
    public static void notify(MinecraftServer server, String title, String text, int kind) {
        KingdomData d = KingdomData.get(server);
        d.addLog("День " + (server.overworld().getDayTime() / 24000L) + ": " + title + " - " + text);
        d.setDirty();
        Net.CHANNEL.send(PacketDistributor.ALL.noArg(), new NotifyPacket(title, text, kind));
    }

    public static void say(MinecraftServer server, String text) {
        notify(server, "Фронт", text, 0);
    }

    // ---------- главный цикл ----------

    public static void tick(MinecraftServer server) {
        KingdomData d = KingdomData.get(server);
        if (!d.founded) return;
        ServerLevel level = server.overworld();
        long t = level.getGameTime();
        if (t - d.lastTurn >= TURN_TICKS) {
            d.lastTurn = t;
            economyTurn(server, level, d);
        }
        if (t >= d.nextRaid) {
            d.nextRaid = t + 10000 + level.random.nextInt(6000);
            raid(level, d);
        }
        outpostTick(level, d);
    }

    // ---------- население и экономика ----------

    private static void economyTurn(MinecraftServer server, ServerLevel level, KingdomData d) {
        revalidateAll(server, level, d);
        for (KingdomData.Building b : d.buildings.values()) {
            if (!b.valid) continue;
            d.food += b.type.food;
            d.iron += b.type.iron;
            d.ammo += b.type.ammo;
        }
        int[] units = countUnits(level);
        int used = d.pop + units[0] + units[1] * 2;
        int need = Mth.ceil(used / 6.0F);
        if (d.food >= need) {
            d.food -= need;
            int room = d.capacity() - used;
            if (room > 0) d.pop += Math.min(room, Math.max(1, d.pop / 8 + 1));
        } else {
            d.food = 0;
            if (d.pop > 0) {
                d.pop--;
                notify(server, "Голод", "Население сокращается. Нужны фермы.", 2);
            }
        }
        d.setDirty();
    }

    /** Заново проверить все здания в загруженных чанках; сообщить, если какое-то перестало работать. */
    public static void revalidateAll(MinecraftServer server, ServerLevel level, KingdomData d) {
        Iterator<Map.Entry<Long, KingdomData.Building>> it = d.buildings.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<Long, KingdomData.Building> e = it.next();
            BlockPos p = BlockPos.of(e.getKey());
            if (!level.isLoaded(p)) continue;
            if (!(level.getBlockState(p).getBlock() instanceof BuildingBlock bb)) {
                it.remove();
                continue;
            }
            KingdomData.Building old = e.getValue();
            KingdomData.Building now = HousingValidator.validate(level, p, bb.type, d);
            if (now == null) continue;
            e.setValue(now);
            if (old.valid && !now.valid) {
                notify(server, bb.type.title + " не работает", now.text, 2);
            } else if (!old.valid && now.valid) {
                notify(server, bb.type.title + " принят", now.text, 0);
            }
        }
    }

    /** Проверить одно здание (при установке и по ПКМ). Возвращает результат или null, если область не загружена. */
    public static KingdomData.Building check(ServerLevel level, BlockPos pos, BuildingType type) {
        KingdomData d = KingdomData.get(level.getServer());
        KingdomData.Building b = HousingValidator.validate(level, pos, type, d);
        if (b != null) {
            d.buildings.put(pos.asLong(), b);
            d.setDirty();
        }
        return b;
    }

    /** [0] - солдаты игрока, [1] - танки игрока. */
    private static int[] countUnits(ServerLevel level) {
        int[] r = new int[2];
        for (Entity e : level.getAllEntities()) {
            if (e instanceof TankEntity t && !t.isEnemy()) r[1]++;
            else if (e instanceof SoldierEntity s && !s.isEnemy()) r[0]++;
        }
        return r;
    }

    // ---------- налёты ----------

    public static void raid(ServerLevel level, KingdomData d) {
        if (!d.founded || !level.isLoaded(d.hq)) return;
        int enemies = 0;
        for (Entity e : level.getAllEntities()) if (e instanceof SoldierEntity s && s.isEnemy()) enemies++;
        if (enemies > 40) return;
        int day = (int) (level.getDayTime() / 24000L);
        int n = Math.min(12, 3 + day / 2 + d.capturedOutposts);
        double ang = level.random.nextDouble() * Math.PI * 2;
        int x = d.hq.getX() + (int) (Math.cos(ang) * 68);
        int z = d.hq.getZ() + (int) (Math.sin(ang) * 68);
        level.getChunk(x >> 4, z >> 4);
        int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
        BlockPos at = new BlockPos(x, y, z);
        for (int i = 0; i < n; i++) {
            SoldierEntity s = SoldierEntity.spawn(level, at, 0, true);
            if (s != null) s.giveOrder(SoldierEntity.ATTACK, d.hq);
        }
        d.raidsSurvived++;
        notify(level.getServer(), "ТРЕВОГА: налёт", n + " солдат с " + direction(ang) + ". Держите оборону у штаба!", 1);
        d.setDirty();
    }

    private static String direction(double ang) {
        String[] names = {"востока", "юго-востока", "юга", "юго-запада", "запада", "северо-запада", "севера", "северо-востока"};
        int i = Math.floorMod((int) Math.round(ang / (Math.PI / 4)), 8);
        return names[i];
    }

    // ---------- форпосты ----------

    public static void ensureOutposts(ServerLevel level, KingdomData d) {
        int target = Math.min(6, 3 + d.capturedOutposts / 2);
        int guard = 0;
        while (d.uncapturedOutposts() < target && guard++ < 12) createOutpost(level, d);
    }

    private static void createOutpost(ServerLevel level, KingdomData d) {
        for (int attempt = 0; attempt < 10; attempt++) {
            double ang = level.random.nextDouble() * Math.PI * 2;
            double dist = 110 + level.random.nextInt(70) + Math.min(80, d.capturedOutposts * 15);
            int x = d.hq.getX() + (int) (Math.cos(ang) * dist);
            int z = d.hq.getZ() + (int) (Math.sin(ang) * dist);
            level.getChunk(x >> 4, z >> 4);
            int y = level.getHeight(Heightmap.Types.WORLD_SURFACE, x, z);
            BlockPos pos = new BlockPos(x, y, z);
            if (!level.getFluidState(pos.below()).isEmpty() || level.getBlockState(pos.below()).isAir()) continue;
            int lvl = 1 + d.capturedOutposts;
            buildOutpost(level, pos);
            int garrison = Math.min(10, 3 + lvl * 2);
            for (int i = 0; i < garrison; i++) {
                SoldierEntity s = SoldierEntity.spawn(level, pos.above(), 0, true);
                if (s != null) s.giveOrder(SoldierEntity.DEFEND, pos);
            }
            d.outposts.add(new KingdomData.Outpost(pos, lvl));
            d.setDirty();
            return;
        }
    }

    private static void buildOutpost(ServerLevel level, BlockPos pos) {
        int r = 5;
        for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
                level.setBlock(pos.offset(dx, -1, dz), Blocks.COBBLESTONE.defaultBlockState(), 2);
                for (int h = 0; h <= 4; h++) level.setBlock(pos.offset(dx, h, dz), Blocks.AIR.defaultBlockState(), 2);
                boolean edge = Math.max(Math.abs(dx), Math.abs(dz)) == r;
                if (edge && dx != 0 && dz != 0) {
                    level.setBlock(pos.offset(dx, 0, dz), Blocks.COBBLESTONE_WALL.defaultBlockState(), 2);
                    level.setBlock(pos.offset(dx, 1, dz), Blocks.COBBLESTONE_WALL.defaultBlockState(), 2);
                }
            }
        }
        for (int h = 0; h <= 2; h++) {
            level.setBlock(pos.above(h), ModBlocks.ENEMY_FLAG.get().defaultBlockState(), 3);
        }
    }

    private static void outpostTick(ServerLevel level, KingdomData d) {
        if (level.getGameTime() % 20 != 0) return;
        List<SoldierEntity> friendly = new ArrayList<>();
        for (Entity e : level.getAllEntities()) if (e instanceof SoldierEntity s && !s.isEnemy()) friendly.add(s);
        boolean dirty = false;
        for (KingdomData.Outpost o : new ArrayList<>(d.outposts)) {
            if (o.captured) continue;
            if (!o.discovered) {
                boolean seen = false;
                for (SoldierEntity s : friendly) if (s.distanceToSqr(o.pos.getX(), s.getY(), o.pos.getZ()) < 90 * 90) seen = true;
                for (ServerPlayer p : level.players()) if (p.distanceToSqr(o.pos.getX(), p.getY(), o.pos.getZ()) < 90 * 90) seen = true;
                if (seen) {
                    o.discovered = true;
                    dirty = true;
                    notify(level.getServer(), "Разведка", "Обнаружен вражеский форпост - он на карте.", 0);
                }
            }
            if (!level.isLoaded(o.pos)) continue;
            AABB box = new AABB(o.pos).inflate(16, 8, 16);
            int enemies = 0;
            for (SoldierEntity s : level.getEntitiesOfClass(SoldierEntity.class, box)) if (s.isEnemy()) enemies++;
            boolean mine = false;
            for (SoldierEntity s : friendly) if (s.distanceToSqr(o.pos.getX() + 0.5, o.pos.getY(), o.pos.getZ() + 0.5) < 36) mine = true;
            for (ServerPlayer p : level.players()) if (p.distanceToSqr(o.pos.getX() + 0.5, o.pos.getY(), o.pos.getZ() + 0.5) < 36) mine = true;
            if (enemies == 0 && mine) {
                o.progress++;
                if (o.progress >= 8) {
                    capture(level, d, o);
                    dirty = true;
                }
            } else if (enemies > 0 && o.progress > 0) {
                o.progress--;
            }
        }
        if (dirty) d.setDirty();
    }

    private static void capture(ServerLevel level, KingdomData d, KingdomData.Outpost o) {
        o.captured = true;
        d.capturedOutposts++;
        d.iron += 60 + 20 * o.level;
        d.ammo += 50 + 15 * o.level;
        d.food += 60;
        for (int h = 0; h <= 2; h++) {
            level.setBlock(o.pos.above(h), Blocks.LIGHT_BLUE_CONCRETE.defaultBlockState(), 3);
        }
        notify(level.getServer(), "Форпост освобождён", "Трофеи: железо, боеприпасы, еда, жильё +10. Враг строит новый форпост.", 0);
        ensureOutposts(level, d);
    }

    // ---------- команды из интерфейса ----------

    public static void recruit(ServerPlayer p, int squad, int count) {
        KingdomData d = KingdomData.get(p.server);
        ServerLevel level = p.server.overworld();
        if (!d.founded || squad < 1 || squad > KingdomData.SQUADS) return;
        int made = 0;
        for (int i = 0; i < Mth.clamp(count, 1, 10); i++) {
            int[] units = countUnits(level);
            if (units[0] >= d.soldierCap()) {
                p.displayClientMessage(Component.literal("Нет мест в казармах (" + units[0] + "/" + d.soldierCap() + "). Построй казарму."), true);
                break;
            }
            if (d.pop < 1 || d.iron < 5 || d.ammo < 5) {
                p.displayClientMessage(Component.literal("Нужно: 1 человек, 5 железа, 5 боеприпасов."), true);
                break;
            }
            d.pop--;
            d.iron -= 5;
            d.ammo -= 5;
            SoldierEntity s = SoldierEntity.spawn(level, spawnPoint(level, d), squad, false);
            if (s != null) inheritOrder(d, s, squad);
            made++;
        }
        if (made > 0) {
            d.setDirty();
            p.displayClientMessage(Component.literal("Новобранцев в отряд " + squad + ": " + made), true);
        }
    }

    public static void buildTank(ServerPlayer p, int squad) {
        KingdomData d = KingdomData.get(p.server);
        ServerLevel level = p.server.overworld();
        if (!d.founded || squad < 1 || squad > KingdomData.SQUADS) return;
        int[] units = countUnits(level);
        if (d.tankCap() <= 0) {
            p.displayClientMessage(Component.literal("Нужен Танковый завод."), true);
        } else if (units[1] >= d.tankCap()) {
            p.displayClientMessage(Component.literal("Лимит танков (" + units[1] + "/" + d.tankCap() + "): построй ещё завод."), true);
        } else if (d.iron < 60 || d.ammo < 40) {
            p.displayClientMessage(Component.literal("Танк стоит 60 железа и 40 боеприпасов."), true);
        } else {
            d.iron -= 60;
            d.ammo -= 40;
            TankEntity t = TankEntity.spawn(level, factoryPoint(level, d), squad);
            if (t != null) inheritOrder(d, t, squad);
            d.setDirty();
            p.displayClientMessage(Component.literal("Танк готов и приписан к отряду " + squad + "."), true);
        }
    }

    public static void order(ServerPlayer p, int squad, int type, int x, int z) {
        KingdomData d = KingdomData.get(p.server);
        ServerLevel level = p.server.overworld();
        if (!d.founded || squad < 1 || squad > KingdomData.SQUADS || type < SoldierEntity.MOVE || type > SoldierEntity.DEFEND) return;
        BlockPos probe = new BlockPos(x, 64, z);
        int y = level.isLoaded(probe) ? level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) : d.hq.getY();
        BlockPos target = new BlockPos(x, y, z);
        d.squadOrder[squad] = type;
        d.squadTarget[squad] = target.asLong();
        int n = 0;
        for (Entity e : level.getAllEntities()) {
            if (e instanceof SoldierEntity s && !s.isEnemy() && s.getSquad() == squad) {
                s.giveOrder(type, target);
                n++;
            }
        }
        d.setDirty();
        String[] names = {"", "Выдвижение", "Атака", "Оборона"};
        p.displayClientMessage(Component.literal("Отряд " + squad + ": " + names[type] + " (" + x + ", " + z + "), бойцов " + n), true);
    }

    private static void inheritOrder(KingdomData d, SoldierEntity s, int squad) {
        if (d.squadOrder[squad] != SoldierEntity.NONE) {
            s.giveOrder(d.squadOrder[squad], BlockPos.of(d.squadTarget[squad]));
        }
    }

    private static BlockPos spawnPoint(ServerLevel level, KingdomData d) {
        List<BlockPos> list = new ArrayList<>();
        for (Map.Entry<Long, KingdomData.Building> e : d.buildings.entrySet()) {
            if (e.getValue().valid && e.getValue().type == BuildingType.BARRACKS) list.add(BlockPos.of(e.getKey()));
        }
        BlockPos base = list.isEmpty() ? d.hq : list.get(level.random.nextInt(list.size()));
        return base.above();
    }

    private static BlockPos factoryPoint(ServerLevel level, KingdomData d) {
        List<BlockPos> list = new ArrayList<>();
        for (Map.Entry<Long, KingdomData.Building> e : d.buildings.entrySet()) {
            if (e.getValue().valid && e.getValue().type == BuildingType.FACTORY) list.add(BlockPos.of(e.getKey()));
        }
        BlockPos base = list.isEmpty() ? d.hq : list.get(level.random.nextInt(list.size()));
        return base.above();
    }

    // ---------- покупки ----------

    public static final int FURNITURE_PRICE = 10;

    /** item: 0..5 - блок здания (по порядку BuildingType), 6 - набор мебели (2 кровати, дверь, 4 факела). */
    public static void buy(ServerPlayer p, int item) {
        KingdomData d = KingdomData.get(p.server);
        if (!d.founded) return;
        BuildingType[] types = BuildingType.values();
        int price;
        String name;
        if (item >= 0 && item < types.length) {
            price = types[item].price;
            name = types[item].title;
        } else if (item == types.length) {
            price = FURNITURE_PRICE;
            name = "Набор мебели";
        } else {
            return;
        }
        if (d.iron < price) {
            p.displayClientMessage(Component.literal("Не хватает железа: нужно " + price + ", есть " + d.iron), true);
            return;
        }
        d.iron -= price;
        d.setDirty();
        if (item < types.length) {
            giveItem(p, new ItemStack(ModItems.BUILDINGS.get(types[item]).get()));
        } else {
            giveItem(p, new ItemStack(Items.RED_BED, 2));
            giveItem(p, new ItemStack(Items.OAK_DOOR, 1));
            giveItem(p, new ItemStack(Items.TORCH, 4));
        }
        p.displayClientMessage(Component.literal("Куплено: " + name + " (-" + price + " железа)"), true);
    }

    public static void giveItem(ServerPlayer p, ItemStack s) {
        if (!p.getInventory().add(s)) p.drop(s, false);
    }

    /** Лёгкий снимок для HUD. */
    public static HudPacket hud(MinecraftServer server) {
        KingdomData d = KingdomData.get(server);
        ServerLevel level = server.overworld();
        int[] u = countUnits(level);
        return new HudPacket((int) (level.getDayTime() / 24000L), d.pop, d.capacity(), d.food, d.iron, d.ammo,
                u[0], d.soldierCap(), u[1], d.tankCap());
    }

    // ---------- снимок для карты ----------

    public static KingdomView view(MinecraftServer server) {
        KingdomData d = KingdomData.get(server);
        ServerLevel level = server.overworld();
        KingdomView v = new KingdomView();
        v.day = (int) (level.getDayTime() / 24000L);
        v.pop = d.pop;
        v.cap = d.capacity();
        v.food = d.food;
        v.iron = d.iron;
        v.ammo = d.ammo;
        v.soldierCap = d.soldierCap();
        v.tankCap = d.tankCap();
        v.raids = d.raidsSurvived;
        v.freed = d.capturedOutposts;
        v.hq = d.hq;
        for (BuildingType t : BuildingType.values()) v.buildings[t.ordinal()] = d.count(t);
        System.arraycopy(d.squadOrder, 0, v.squadOrder, 0, v.squadOrder.length);
        v.log.addAll(d.log);
        v.markers.add(new KingdomView.Marker(KingdomView.M_HQ, d.hq.getX(), d.hq.getZ(), 0));
        for (Map.Entry<Long, KingdomData.Building> e : d.buildings.entrySet()) {
            BlockPos p = BlockPos.of(e.getKey());
            KingdomData.Building bd = e.getValue();
            v.markers.add(new KingdomView.Marker(KingdomView.M_BUILDING + bd.type.ordinal(), p.getX(), p.getZ(), bd.valid ? 0 : 1));
            v.buildingList.add(new KingdomView.BuildingView(bd.type.ordinal(), p.getX(), p.getY(), p.getZ(),
                    bd.capacity, bd.valid, bd.text));
        }
        for (KingdomData.Outpost o : d.outposts) {
            if (o.captured) v.markers.add(new KingdomView.Marker(KingdomView.M_FREED, o.pos.getX(), o.pos.getZ(), 0));
            else if (o.discovered) v.markers.add(new KingdomView.Marker(KingdomView.M_OUTPOST, o.pos.getX(), o.pos.getZ(), 0));
        }
        for (int s = 1; s <= KingdomData.SQUADS; s++) {
            if (d.squadOrder[s] != SoldierEntity.NONE) {
                BlockPos p = BlockPos.of(d.squadTarget[s]);
                v.markers.add(new KingdomView.Marker(KingdomView.M_ORDER, p.getX(), p.getZ(), s));
            }
        }
        List<SoldierEntity> friendly = new ArrayList<>();
        List<SoldierEntity> enemy = new ArrayList<>();
        for (Entity e : level.getAllEntities()) {
            if (e instanceof SoldierEntity s) (s.isEnemy() ? enemy : friendly).add(s);
        }
        for (SoldierEntity s : friendly) {
            boolean tank = s instanceof TankEntity;
            if (tank) v.squadTanks[s.getSquad()]++;
            else v.squadSoldiers[s.getSquad()]++;
            v.markers.add(new KingdomView.Marker(tank ? KingdomView.M_TANK : KingdomView.M_SOLDIER,
                    s.getBlockX(), s.getBlockZ(), s.getSquad()));
        }
        v.soldiers = 0;
        v.tanks = 0;
        for (int i = 1; i <= KingdomData.SQUADS; i++) {
            v.soldiers += v.squadSoldiers[i];
            v.tanks += v.squadTanks[i];
        }
        int shown = 0;
        for (SoldierEntity e : enemy) {
            if (shown >= 80) break;
            for (SoldierEntity f : friendly) {
                if (f.distanceToSqr(e) < 60 * 60) {
                    v.markers.add(new KingdomView.Marker(KingdomView.M_ENEMY, e.getBlockX(), e.getBlockZ(), 0));
                    shown++;
                    break;
                }
            }
        }
        return v;
    }
}
