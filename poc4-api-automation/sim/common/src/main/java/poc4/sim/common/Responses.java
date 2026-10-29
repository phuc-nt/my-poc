package poc4.sim.common;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/** Builds the OK answers controllers return. */
public final class Responses {
    private Responses() {
    }

    public static <T> ResponseEntity<RestApiResponse<T>> ok(T data) {
        return ResponseEntity.ok(RestApiResponse.ok(data));
    }

    public static <T> ResponseEntity<RestApiResponse<T>> created(T data) {
        return ResponseEntity.status(HttpStatus.CREATED).body(RestApiResponse.ok(data));
    }

    public static <T> ResponseEntity<RestApiResponse<T>> accepted(T data) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(RestApiResponse.ok(data));
    }
}
