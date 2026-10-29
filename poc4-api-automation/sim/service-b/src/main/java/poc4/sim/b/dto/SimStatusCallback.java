package poc4.sim.b.dto;

import javax.validation.constraints.NotNull;
import javax.validation.constraints.Pattern;

/** What the carrier sends when a SIM order finishes or a SIM is deactivated. */
public class SimStatusCallback {
    @NotNull
    @Pattern(regexp = "^\\d{19,20}$", message = "must be an ICCID of 19 or 20 digits")
    public String iccid;
    @NotNull
    public SimState status;
}
