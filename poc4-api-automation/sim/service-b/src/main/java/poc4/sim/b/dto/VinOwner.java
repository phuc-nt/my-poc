package poc4.sim.b.dto;

public class VinOwner {
    public String vin;
    public String userId;
    public String ownershipId;

    public VinOwner(String vin, String userId, String ownershipId) {
        this.vin = vin;
        this.userId = userId;
        this.ownershipId = ownershipId;
    }
}
