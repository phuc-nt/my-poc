package poc4.sim.common.validation;

import static java.lang.annotation.ElementType.FIELD;
import static java.lang.annotation.ElementType.PARAMETER;
import static java.lang.annotation.RetentionPolicy.RUNTIME;

import java.lang.annotation.Documented;
import java.lang.annotation.Retention;
import java.lang.annotation.Target;
import javax.validation.Constraint;
import javax.validation.ConstraintValidator;
import javax.validation.ConstraintValidatorContext;
import javax.validation.Payload;

/** A PIN: six digits, not all the same digit and not a run such as 123456 or 654321. */
@Documented
@Constraint(validatedBy = Pin.Validator.class)
@Target({FIELD, PARAMETER})
@Retention(RUNTIME)
public @interface Pin {
    String message() default "must be six digits, not repeated and not a run";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};

    class Validator implements ConstraintValidator<Pin, String> {
        @Override
        public boolean isValid(String value, ConstraintValidatorContext context) {
            if (value == null) {
                return true;
            }
            if (!value.matches("\\d{6}")) {
                return false;
            }
            boolean same = true, up = true, down = true;
            for (int i = 1; i < value.length(); i++) {
                int step = value.charAt(i) - value.charAt(i - 1);
                same &= step == 0;
                up &= step == 1;
                down &= step == -1;
            }
            return !(same || up || down);
        }
    }
}
