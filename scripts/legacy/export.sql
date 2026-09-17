-- Selected content only: no accounts, passwords, sessions, or personal records.
BEGIN READ ONLY;
SELECT json_build_object(
 'spaces', (SELECT json_agg(row_to_json(s)) FROM (
   SELECT id, title, description, privacy, space_type, src, version, thumbnail,
          share_image, mesh, video, source_data, space_data, created_at, updated_at
   FROM app_space ORDER BY id
 ) s),
 'tours', (SELECT json_agg(row_to_json(t)) FROM (
   SELECT id, title, description, privacy, thumbnail, share_image, video, tour_data,
          continue_exploring_link, created_at, updated_at,
          (SELECT json_agg(space_id ORDER BY space_id) FROM app_tour_spaces WHERE tour_id=app_tour.id) AS space_ids
   FROM app_tour ORDER BY id
 ) t)
);
ROLLBACK;
