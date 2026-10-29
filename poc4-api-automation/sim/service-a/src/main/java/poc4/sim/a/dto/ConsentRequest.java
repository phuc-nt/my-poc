package poc4.sim.a.dto;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Pattern;

public class ConsentRequest {
    @NotBlank
    @Pattern(regexp = "^\\d{1,3}\\.\\d{1,3}$", message = "must be a version such as 2.1")
    public String version;
    @NotNull
    public Boolean agreed;
}
