package poc4.sim.a.repository;

import java.time.LocalDate;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface ConsentRepository {
    List<ConsentRecord> findByUser(@Param("userId") String userId);

    List<ConsentRecord> findUpdatedBetween(@Param("from") LocalDate from, @Param("to") LocalDate to);

    void upsert(ConsentRecord consent);
}
