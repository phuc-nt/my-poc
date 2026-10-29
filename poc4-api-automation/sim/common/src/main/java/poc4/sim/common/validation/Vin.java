package poc4.sim.common.validation;

import static java.lang.annotation.ElementType.FIELD;
import static java.lang.annotation.ElementType.PARAMETER;
import static java.lang.annotation.RetentionPolicy.RUNTIME;

import java.lang.annotation.Documented;
import java.lang.annotation.Retention;
import java.lang.annotation.Target;
import javax.validation.Constraint;
import javax.validation.Payload;
import javax.validation.ReportAsSingleViolation;
import javax.validation.constraints.Pattern;

/** A vehicle identification number: 17 characters, digits and capitals without I, O and Q. */
@Documented
@Constraint(validatedBy = {})
@Target({FIELD, PARAMETER})
@Retention(RUNTIME)
@Pattern(regexp = "^[A-HJ-NPR-Z0-9]{17}$")
@ReportAsSingleViolation
public @interface Vin {
    String message() default "must be 17 characters, digits and capitals without I, O and Q";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
