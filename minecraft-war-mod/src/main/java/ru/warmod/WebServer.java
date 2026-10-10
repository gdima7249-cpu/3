package ru.warmod;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import ru.warmod.core.Country;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Мини-сайт рейтинга: "страна месяца / года / за всё время" с генералами.
 * Данные обновляются в основном потоке и отдаются из кэша, поэтому HTTP-потоки не трогают игровое состояние.
 */
public final class WebServer {
    private final WarMod plugin;
    private final int port;
    private HttpServer server;
    private volatile String json = "{\"month\":[],\"year\":[],\"all\":[]}";
    private int taskId = -1;

    public WebServer(WarMod plugin, int port) {
        this.plugin = plugin;
        this.port = port;
    }

    public void start() {
        try {
            server = HttpServer.create(new InetSocketAddress(port), 0);
        } catch (IOException e) {
            plugin.getLogger().warning("Сайт рейтинга не запущен: " + e.getMessage());
            return;
        }
        server.createContext("/api/ranking", ex -> send(ex, "application/json; charset=utf-8", json));
        server.createContext("/", ex -> send(ex, "text/html; charset=utf-8", PAGE));
        server.start();
        taskId = Bukkit.getScheduler().runTaskTimer(plugin, this::refresh, 20L, 600L).getTaskId();
        plugin.getLogger().info("Сайт рейтинга: http://<ip сервера>:" + port + "/");
    }

    public void stop() {
        if (taskId != -1) Bukkit.getScheduler().cancelTask(taskId);
        if (server != null) server.stop(0);
    }

    private void refresh() {
        long now = plugin.now();
        json = "{\"month\":" + table(Country.monthKey(now)) + ",\"year\":" + table(Country.yearKey(now))
                + ",\"all\":" + table("all") + "}";
    }

    private String table(String key) {
        List<Country> top = plugin.state.ranking(key);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < Math.min(10, top.size()); i++) {
            Country c = top.get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"country\":\"").append(esc(c.name)).append("\",\"general\":\"")
                    .append(esc(c.leaderMember() == null ? "" : c.leaderMember().name))
                    .append("\",\"members\":").append(c.size())
                    .append(",\"conquests\":").append(c.conquests)
                    .append(",\"score\":").append(c.scoreOf(key)).append('}');
        }
        return sb.append(']').toString();
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void send(HttpExchange ex, String type, String body) throws IOException {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(200, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    private static final String PAGE = """
            <!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Война стран - рейтинг</title>
            <style>
            body{font-family:system-ui,sans-serif;background:#14161a;color:#e8e8e8;margin:0;padding:24px}
            h1{margin:0 0 16px}h2{margin:24px 0 8px;color:#f0b429}
            table{border-collapse:collapse;width:100%;max-width:720px}
            td,th{padding:6px 10px;border-bottom:1px solid #2c3038;text-align:left}
            .crown{color:#f0b429;font-weight:700}
            </style></head><body>
            <h1>Война стран</h1>
            <div id="out">Загрузка...</div>
            <script>
            const titles={month:"Страна месяца",year:"Страна года",all:"Страна за всё время"};
            function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
            async function load(){
              const d=await (await fetch("/api/ranking")).json();
              let h="";
              for(const k of ["month","year","all"]){
                h+="<h2>"+titles[k]+"</h2>";
                if(!d[k].length){h+="<p>Пока никто не набрал очков.</p>";continue;}
                h+="<table><tr><th>#</th><th>Страна</th><th>Генерал</th><th>Бойцов</th><th>Захватов</th><th>Очки</th></tr>";
                d[k].forEach((r,i)=>{h+="<tr><td>"+(i+1)+"</td><td class='"+(i?"":"crown")+"'>"+esc(r.country)+"</td><td>"+esc(r.general)+"</td><td>"+r.members+"</td><td>"+r.conquests+"</td><td>"+r.score+"</td></tr>"});
                h+="</table>";
              }
              document.getElementById("out").innerHTML=h;
            }
            load();setInterval(load,30000);
            </script></body></html>
            """;
}
