package poc4.sim.common;

import java.util.function.Supplier;
import org.slf4j.MDC;

/** The current request's X-One-Time-Uuid, kept for the log lines and the downstream calls it causes. */
public final class Correlation {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private Correlation() {
    }

    public static String get() {
        return CURRENT.get();
    }

    static void set(String id) {
        CURRENT.set(id);
        MDC.put("oneTimeUuid", id);
    }

    static void clear() {
        CURRENT.remove();
        MDC.remove("oneTimeUuid");
    }

    /** Runs work outside a request (a queue worker) under the id of the request that caused it. */
    public static <T> T with(String id, Supplier<T> work) {
        set(id);
        try {
            return work.get();
        } finally {
            clear();
        }
    }
}
