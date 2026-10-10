package ru.warmod.core;

import java.util.UUID;

/** Запуск без зависимостей: java -cp out ru.warmod.core.CoreSelfTest */
public final class CoreSelfTest {
    static int checks;

    static void check(boolean cond, String what) {
        checks++;
        if (!cond) throw new AssertionError("FAIL: " + what);
    }

    static UUID[] players(WarState s, int n) {
        UUID[] u = new UUID[n];
        for (int i = 0; i < n; i++) { u[i] = UUID.randomUUID(); s.ensureWallet(u[i]); }
        return u;
    }

    public static void main(String[] args) {
        long now = 1_000_000L;

        // --- создание страны ---
        WarState s = new WarState();
        UUID[] p = players(s, 6);
        check(!s.create(p[0], "A", "Альфа", "RED", "w", 0, 64, 0, false, 0, now).ok(), "create needs money (200 < 500)");
        s.give(p[0], 1000);
        check(s.create(p[0], "A", "Альфа", "RED", "w", 0, 64, 0, false, 0, now).ok(), "create ok");
        check(s.balance(p[0]) == 700, "cost taken");
        check(!s.create(p[0], "A", "Бета", "RED", "w", 0, 64, 0, true, 0, now).ok(), "second country denied");
        check(!s.create(p[1], "B", "альфа", "RED", "w", 0, 64, 0, true, 0, now).ok(), "duplicate name denied");
        check(!s.create(p[1], "B", "x", "RED", "w", 0, 64, 0, true, 0, now).ok(), "short name denied");
        check(s.create(p[1], "B", "Бета", "BLUE", "w", 100, 64, 0, true, 0, now).ok(), "free create (donor permission)");
        check(s.memberOf(p[0]).rank == Rank.GENERAL && s.byName("Альфа").leader.equals(p[0]), "founder is general+leader");

        // --- лимит: онлайн 50 -> 100 мест ---
        for (int i = 0; i < 10; i++) s.recordOnline(50);
        check(s.memberLimit(50) == 100, "limit 50*2=100");
        check(s.memberLimit(0) == 100, "limit uses rolling average");

        // --- цена входа: большая платная, малая с бонусом ---
        WarState w = new WarState();
        UUID[] u = players(w, 20);
        w.create(u[0], "L", "Большая", "RED", "w", 0, 0, 0, true, 0, now);
        w.create(u[1], "S", "Малая", "BLUE", "w", 50, 0, 0, true, 0, now);
        for (int i = 2; i < 9; i++) w.addMember(w.byName("Большая"), u[i], "p" + i, Rank.PRIVATE, now);
        long big = w.joinPrice(w.byName("Большая")), small = w.joinPrice(w.byName("Малая"));
        check(big > 0, "big country costs: " + big);
        check(small < 0, "small country pays bonus: " + small);
        long b0 = w.balance(u[9]);
        check(w.join(u[9], "p9", w.byName("Малая"), 20, now).ok() && w.balance(u[9]) == b0 - small, "bonus paid on joining small");
        long t0 = w.byName("Большая").treasury;
        long fee = w.joinPrice(w.byName("Большая"));
        check(w.join(u[10], "p10", w.byName("Большая"), 20, now).ok() && w.byName("Большая").treasury == t0 + fee, "fee goes to treasury");
        w.wallets.put(u[11], 0L);
        check(!w.join(u[11], "p11", w.byName("Большая"), 20, now).ok(), "broke player can't join big country");
        // лимит: 2 онлайн * 2 = 4 места (минимум снижен до 1)
        w.rules.minLimit = 1;
        check(w.memberLimit(2) == 4 && w.byName("Большая").size() > 4, "limit math");
        check(!w.join(u[12], "p12", w.byName("Большая"), 2, now).ok(), "full country refuses");

        // --- звания ---
        UUID gen = u[0], sol = u[2];
        check(!w.promote(sol, u[3]).ok(), "private can't promote");
        check(w.addMerit(sol, 100) == Rank.SERGEANT, "auto sergeant at 100 merit");
        // не-правитель должен соблюдать пороги заслуг
        w.memberOf(u[3]).rank = Rank.OFFICER;
        check(!w.promote(u[3], u[5]).ok(), "non-leader officer: sergeant needs merit");
        w.addMerit(u[5], 100);
        check(w.memberOf(u[5]).rank == Rank.SERGEANT, "u5 auto sergeant");
        check(!w.promote(u[3], u[5]).ok(), "officer needs merit and can't raise to own rank");
        w.memberOf(u[3]).rank = Rank.PRIVATE;
        check(w.promote(gen, sol).ok() && w.memberOf(sol).rank == Rank.OFFICER, "leader promotes to officer");
        check(w.promote(gen, sol).ok() && w.memberOf(sol).rank == Rank.GENERAL, "leader makes general");
        check(w.demote(gen, sol).ok() && w.memberOf(sol).rank == Rank.OFFICER, "leader demotes general");
        check(!w.fire(gen, gen).ok(), "can't fire self");
        check(!w.fire(u[3], u[4]).ok(), "private can't fire");
        check(w.fire(gen, u[4]).ok() && w.countryOf(u[4]) == null, "general fires anyone");
        check(w.fire(sol, u[3]).ok(), "officer fires private");
        check(!w.fire(sol, u[5]).ok() || w.memberOf(u[5]) == null, "officer fire private only");

        // --- гибель правителя ---
        Rank before = w.memberOf(sol).rank;
        WarState.Result r = w.leaderDied(gen);
        check(r.ok() && w.byName("Большая").leader.equals(sol), "leader dies -> heir (highest rank) rules: " + r.message());
        check(w.memberOf(sol).rank == Rank.GENERAL && w.memberOf(gen).rank == Rank.SERGEANT, "heir general, old leader demoted");
        check(before == Rank.OFFICER, "heir was officer");
        check(!w.leaderDied(u[1]).ok() || w.byName("Малая").size() > 1, "lone leader keeps country");

        // --- казна ---
        w.give(sol, 500);
        check(w.deposit(sol, 300).ok(), "deposit");
        check(!w.withdraw(gen, 10).ok(), "sergeant can't withdraw");
        check(w.withdraw(sol, 100).ok(), "general withdraws");
        check(!w.withdraw(sol, 10_000_000).ok(), "can't overdraw");

        // --- захват страны ---
        Country win = w.byName("Большая"), lose = w.byName("Малая");
        lose.treasury = 400;
        long wt = win.treasury;
        WarState.Conquest cq = w.conquest(win, lose, now);
        check(w.byName("Малая") == null && cq.formerMembers().size() == 2, "loser removed, members released");
        check(win.treasury == wt + 400 && cq.spoils() == 400, "spoils to winner");
        check(w.countryOf(u[1]) == null, "members have no country");
        check(w.payCompensation(win, 2) == 2 * w.rules.compensationPerRefusal, "compensation for refusals");
        check(win.scoreOf("all") == w.rules.conquestPoints, "conquest score");

        // --- рейтинг ---
        check(w.ranking("all").get(0) == win, "ranking top");

        // --- ИИ ---
        Country ai = w.createAi("Ост", "GREEN", "w", 9, 9, 9, 3, 0, now);
        check(!w.join(u[14], "p14", ai, 20, now).ok(), "can't join AI country");
        check(w.humanCountries().size() == 1 && w.aiCountries().size() == 1, "ai separated");

        // --- задания ---
        Task t = Task.generate(Rank.OFFICER, new java.util.Random(1));
        check(t.target > 0 && t.reward > 0, "task generated");

        System.out.println("OK: " + checks + " проверок пройдено");
    }
}
