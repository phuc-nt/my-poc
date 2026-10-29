package poc4.sim.b.dto;

/** Subscription plans and their monthly price in yen. */
public enum Plan {
    BASIC(980), PREMIUM(1980);

    private final int price;

    Plan(int price) {
        this.price = price;
    }

    public int getPrice() { return price; }
}
