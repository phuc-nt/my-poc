package poc4.sim.b.dto;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Pattern;
import poc4.sim.common.validation.Vin;

public class VinRegistrationRequest {
    @NotNull
    @Vin
    public String vin;
    @NotBlank
    @Pattern(regexp = "^[A-Z0-9]{3,10}$", message = "must be 3 to 10 capitals and digits")
    public String modelCode;
}
