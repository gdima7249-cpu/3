package ru.warmod.core;

/** Числовые правила игры. Значения по умолчанию переопределяются из config.yml. */
public final class Rules {
    public long startBalance = 200;
    public long createCost = 500;
    /** Базовая цена входа: платит тот, кто идёт в страну больше средней, и получает бонус при входе в маленькую. */
    public long joinBase = 100;
    public long maxJoinFee = 400;
    public long maxJoinBonus = 150;
    public int minLimit = 10;
    public double limitMultiplier = 2.0;
    public int sergeantMerit = 100;
    public int officerMerit = 500;
    public Rank leaderDemotedTo = Rank.SERGEANT;
    public boolean leaderDeathLosesCountry = true;
    public long compensationPerRefusal = 150;
    public long killReward = 25;
    public int killMerit = 5;
    public int conquestPoints = 500;
    public int killPoints = 5;
    public int taskPoints = 10;
}
