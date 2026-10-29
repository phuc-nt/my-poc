package poc4.sim.a.repository;

import java.time.LocalDate;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface UserRepository {
    UserRecord findById(@Param("userId") String userId);

    List<UserRecord> search(@Param("email") String email, @Param("size") int size, @Param("offset") int offset);

    long count(@Param("email") String email);

    List<UserRecord> findCreatedBetween(@Param("from") LocalDate from, @Param("to") LocalDate to);

    void recordPinFailure(@Param("userId") String userId, @Param("attempts") int attempts, @Param("locked") boolean locked);

    void updatePin(@Param("userId") String userId, @Param("pinHash") String pinHash);

    void unlock(@Param("userId") String userId);
}
