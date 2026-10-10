package ru.warmod;

import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.map.MapCanvas;
import org.bukkit.map.MapRenderer;
import org.bukkit.map.MapView;
import org.bukkit.map.MinecraftFont;
import ru.warmod.core.Country;

import java.awt.Color;
import java.util.List;
import java.util.UUID;

/**
 * Рисует поверх карты местности: флаги стран, своих бойцов, маршрут приказа и его режим.
 * Цвета: синий - твоя столица, красный - враги, оранжевый - ИИ, зелёный - свои бойцы, жёлтый - маршрут.
 */
public final class TacticalRenderer extends MapRenderer {
    private static final Color MINE = new Color(40, 90, 255), ENEMY = new Color(230, 40, 40),
            AI = new Color(255, 150, 0), FRIEND = new Color(40, 220, 60), ROUTE = new Color(255, 230, 0),
            SELF = Color.WHITE, BLACK = Color.BLACK;

    private final WarMod plugin;

    public TacticalRenderer(WarMod plugin) {
        super(true);
        this.plugin = plugin;
    }

    @Override
    public void render(MapView map, MapCanvas canvas, Player player) {
        if (map.getWorld() == null || !map.getWorld().equals(player.getWorld())) return;
        int per = 1 << map.getScale().getValue();
        int cx = map.getCenterX(), cz = map.getCenterZ();
        Country mine = plugin.state.countryOf(player.getUniqueId());
        Tactics.Plan plan = plugin.tactics.plan(player.getUniqueId());

        for (Country c : plugin.state.countries.values()) {
            if (!c.world.equals(map.getWorld().getName())) continue;
            Color col = c == mine ? MINE : c.ai ? AI : ENEMY;
            box(canvas, px(c.x, cx, per), px(c.z, cz, per), 3, col);
        }
        if (mine != null) {
            for (UUID id : mine.members.keySet()) {
                Player p = org.bukkit.Bukkit.getPlayer(id);
                if (p == null || p == player || !p.getWorld().equals(map.getWorld())) continue;
                box(canvas, px(p.getLocation().getBlockX(), cx, per), px(p.getLocation().getBlockZ(), cz, per), 1, FRIEND);
            }
        }

        List<Location> pts = plan.points;
        for (int i = 0; i < pts.size(); i++) {
            int x = px(pts.get(i).getBlockX(), cx, per), y = px(pts.get(i).getBlockZ(), cz, per);
            if (i > 0) {
                line(canvas, px(pts.get(i - 1).getBlockX(), cx, per), px(pts.get(i - 1).getBlockZ(), cz, per), x, y);
            }
        }
        for (int i = 0; i < pts.size(); i++) {
            int x = px(pts.get(i).getBlockX(), cx, per), y = px(pts.get(i).getBlockZ(), cz, per);
            box(canvas, x, y, 2, ROUTE);
            if (x + 5 < 128 && y - 3 >= 0 && y - 3 < 120) canvas.drawText(Math.max(0, x + 4), Math.max(0, y - 3), MinecraftFont.Font, String.valueOf(i + 1));
        }
        box(canvas, px(player.getLocation().getBlockX(), cx, per), px(player.getLocation().getBlockZ(), cz, per), 1, SELF);
        canvas.drawText(2, 2, MinecraftFont.Font, plan.mode.latin + " " + pts.size() + "/" + Tactics.MAX_POINTS);
    }

    private static int px(int world, int center, int per) {
        return Math.floorDiv(world - center, per) + 64;
    }

    private static void box(MapCanvas c, int x, int y, int r, Color col) {
        for (int dx = -r; dx <= r; dx++) {
            for (int dy = -r; dy <= r; dy++) {
                boolean edge = Math.abs(dx) == r || Math.abs(dy) == r;
                set(c, x + dx, y + dy, edge && r > 1 ? BLACK : col);
            }
        }
    }

    private static void line(MapCanvas c, int x0, int y0, int x1, int y1) {
        int dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        int sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        int err = dx - dy;
        for (int guard = 0; guard < 400; guard++) {
            set(c, x0, y0, ROUTE);
            if (x0 == x1 && y0 == y1) break;
            int e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    private static void set(MapCanvas c, int x, int y, Color col) {
        if (x >= 0 && x < 128 && y >= 0 && y < 128) c.setPixelColor(x, y, col);
    }
}
