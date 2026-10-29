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

/** A user id from the identity provider: provider|id, such as auth0|pw-user-01. */
@Documented
@Constraint(validatedBy = {})
@Target({FIELD, PARAMETER})
@Retention(RUNTIME)
@Pattern(regexp = "^[a-z0-9-]+\\|[A-Za-z0-9._-]{3,64}$")
@ReportAsSingleViolation
public @interface UserId {
    String message() default "must be a user id such as provider|id";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
