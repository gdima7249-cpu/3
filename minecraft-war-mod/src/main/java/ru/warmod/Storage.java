package ru.warmod;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import ru.warmod.core.Rules;
import ru.warmod.core.WarState;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

public final class Storage {
    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final Path file;

    public Storage(Path dir) {
        this.file = dir.resolve("data.json");
    }

    public WarState load(Rules rules) {
        WarState s = null;
        if (Files.exists(file)) {
            try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                s = gson.fromJson(r, WarState.class);
            } catch (Exception e) {
                throw new IllegalStateException("Не удалось прочитать " + file + ": " + e.getMessage(), e);
            }
        }
        if (s == null) s = new WarState();
        s.rules = rules;
        s.reindex();
        return s;
    }

    public synchronized void save(WarState s) throws IOException {
        Files.createDirectories(file.getParent());
        Path tmp = file.resolveSibling("data.json.tmp");
        try (Writer w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
            gson.toJson(s, w);
        }
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
    }
}
