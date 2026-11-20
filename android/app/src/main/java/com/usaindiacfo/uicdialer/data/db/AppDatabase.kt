package com.usaindiacfo.uicdialer.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [RecordingEntity::class, CachedCallEntity::class, ClientHashEntity::class, PendingActivityEntity::class, PendingMissedEntity::class, DncHashEntity::class], version = 5, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun recordings(): RecordingDao
    abstract fun cachedCalls(): CachedCallDao
    abstract fun clientHashes(): ClientHashDao
    abstract fun pendingActivities(): PendingActivityDao
    abstract fun pendingMissed(): PendingMissedDao
    abstract fun dncHashes(): DncHashDao

    /**
     * Session ended by the server (revoked device, expired refresh): drop cached and sync state but keep queued
     * dialer outcomes, which exist nowhere else. They are sent after the same rep signs in again, and dropped if
     * a different rep signs in (see AuthRepository.signIn). Recordings are rediscovered by the next scan.
     */
    fun clearExceptQueuedActivities() = runInTransaction {
        val db = openHelper.writableDatabase
        listOf("recordings", "cached_calls", "client_hashes", "pending_missed", "dnc_hashes").forEach { db.execSQL("DELETE FROM `$it`") }
    }

    companion object {
        /** v2 (Milestone 3): business-only client list. Keeps all recording sync state. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `client_hashes` (`hash` TEXT NOT NULL, PRIMARY KEY(`hash`))")
            }
        }

        /** v3 (dialer): queue of activities waiting for POST /v1/activities. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_activities` (`clientId` TEXT NOT NULL, `phone` TEXT NOT NULL, " +
                        "`type` TEXT NOT NULL, `outcome` TEXT, `note` TEXT, `followUpAt` TEXT, `durationS` INTEGER, " +
                        "`occurredAt` TEXT NOT NULL, `name` TEXT, `company` TEXT, `attempts` INTEGER NOT NULL, " +
                        "`lastError` TEXT, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`clientId`))",
                )
            }
        }

        /** v4 (stage 1): missed calls waiting for POST /v1/followups/missed. */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_missed` (`clientId` TEXT NOT NULL, `phone` TEXT NOT NULL, " +
                        "`occurredAtMs` INTEGER NOT NULL, `callerName` TEXT, PRIMARY KEY(`clientId`))",
                )
            }
        }

        /** v5 (stage 2/3): outcome/list/message fields on queued activities, and the hashed do-not-call list. */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                listOf("outcomeId", "callListItemId", "channel", "templateId").forEach {
                    db.execSQL("ALTER TABLE `pending_activities` ADD COLUMN `$it` TEXT")
                }
                db.execSQL("CREATE TABLE IF NOT EXISTS `dnc_hashes` (`hash` TEXT NOT NULL, PRIMARY KEY(`hash`))")
            }
        }

        fun build(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "uic.db")
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5)
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
    }
}
