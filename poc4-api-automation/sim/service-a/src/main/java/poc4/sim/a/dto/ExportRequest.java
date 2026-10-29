package poc4.sim.a.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import javax.validation.constraints.AssertTrue;
import javax.validation.constraints.Email;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Size;

public class ExportRequest {
    public static final int MAX_DAYS = 31;

    @NotNull
    public ExportKind kind;
    @NotNull
    public LocalDate from;
    @NotNull
    public LocalDate to;
    @Email
    @Size(max = 254)
    public String notifyEmail;

    @JsonIgnore
    @Schema(hidden = true)
    @AssertTrue(message = "from must not be after to, and the range must be at most 31 days")
    public boolean isRange() {
        return from == null || to == null || (!from.isAfter(to) && ChronoUnit.DAYS.between(from, to) < MAX_DAYS);
    }
}
