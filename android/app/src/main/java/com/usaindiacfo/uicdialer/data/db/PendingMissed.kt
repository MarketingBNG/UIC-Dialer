package com.usaindiacfo.uicdialer.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/** A missed call waiting for POST /v1/followups/missed (idempotent by [clientId]). */
@Entity(tableName = "pending_missed")
data class PendingMissedEntity(
    @PrimaryKey val clientId: String,
    val phone: String,
    val occurredAtMs: Long,
    val callerName: String?,
)

@Dao
interface PendingMissedDao {
    /** Row id, or -1 when this call is already queued. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: PendingMissedEntity): Long

    @Query("SELECT * FROM pending_missed ORDER BY occurredAtMs LIMIT :limit")
    suspend fun nextBatch(limit: Int = 50): List<PendingMissedEntity>

    @Query("DELETE FROM pending_missed WHERE clientId IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM pending_missed")
    suspend fun deleteAll()
}
