package poc4.sim.b.repository;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface SubscriptionRepository {
    List<SubscriptionRecord> findByOwnership(@Param("ownershipId") String ownershipId);

    int countActive(@Param("ownershipId") String ownershipId);

    void insert(SubscriptionRecord subscription);
}
