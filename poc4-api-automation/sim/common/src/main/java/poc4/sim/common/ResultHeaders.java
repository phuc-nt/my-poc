package poc4.sim.common;

import org.springframework.http.HttpHeaders;

/** The correlation header a caller sends, and the result headers every answer carries. */
public final class ResultHeaders {
    public static final String REQUEST_UUID = "X-One-Time-Uuid";
    public static final String ONE_TIME_UUID = "X_ONE_TIME_UUID";
    public static final String EVENT_TIME = "X_EVENT_TIME";
    public static final String RESULT_STATUS = "X_RESULT_STATUS";
    public static final String ERROR_CODE = "X_ERROR_CODE";

    private ResultHeaders() {
    }

    static void apply(HttpHeaders headers, RestApiResponse<?> body) {
        headers.set(RESULT_STATUS, body.getResult());
        if (body.getErrors() != null && !body.getErrors().isEmpty()) {
            headers.set(ERROR_CODE, body.getErrors().get(0).getCode());
        }
    }
}
