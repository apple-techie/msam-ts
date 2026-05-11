-- Merge redundant/singleton types into their canonical equivalents.
-- Mirrors the TYPE_ALIASES map in src/knowledge/triples.ts.

UPDATE triples SET subject_type = 'Organization'   WHERE subject_type IN ('Company','Companies','Corporation','Enterprise','Inc');
UPDATE triples SET object_type  = 'Organization'   WHERE object_type  IN ('Company','Companies','Corporation','Enterprise','Inc');

UPDATE triples SET subject_type = 'Person'         WHERE subject_type IN ('People','Persons','Humans','Individual');
UPDATE triples SET object_type  = 'Person'         WHERE object_type  IN ('People','Persons','Humans','Individual');

UPDATE triples SET subject_type = 'AI_Agent'       WHERE subject_type IN ('Ai','Ai_Agents','AI_Agents');
UPDATE triples SET object_type  = 'AI_Agent'       WHERE object_type  IN ('Ai','Ai_Agents','AI_Agents');

UPDATE triples SET subject_type = 'VC_Firm'        WHERE subject_type IN ('Vc','Venture_Capital','Vc_Fund');
UPDATE triples SET object_type  = 'VC_Firm'        WHERE object_type  IN ('Vc','Venture_Capital','Vc_Fund');

UPDATE triples SET subject_type = 'Repository'     WHERE subject_type IN ('Repos');
UPDATE triples SET object_type  = 'Repository'     WHERE object_type  IN ('Repos');

UPDATE triples SET subject_type = 'Cron_Job'       WHERE subject_type IN ('Crons','Crontab');
UPDATE triples SET object_type  = 'Cron_Job'       WHERE object_type  IN ('Crons','Crontab');

UPDATE triples SET subject_type = 'Metric'         WHERE subject_type IN ('Frequency');
UPDATE triples SET object_type  = 'Metric'         WHERE object_type  IN ('Frequency');

UPDATE triples SET subject_type = 'Concept'        WHERE subject_type IN ('Code_Concept');
UPDATE triples SET object_type  = 'Concept'        WHERE object_type  IN ('Code_Concept');

UPDATE triples SET subject_type = 'Role'           WHERE subject_type IN ('Career','Career_Path');
UPDATE triples SET object_type  = 'Role'           WHERE object_type  IN ('Career','Career_Path');

UPDATE triples SET subject_type = 'Event'          WHERE subject_type IN ('Sprint');
UPDATE triples SET object_type  = 'Event'          WHERE object_type  IN ('Sprint');

-- Plural -> singular canonicalization
UPDATE triples SET subject_type = 'Document'       WHERE subject_type IN ('Documents','Docs');
UPDATE triples SET object_type  = 'Document'       WHERE object_type  IN ('Documents','Docs');

UPDATE triples SET subject_type = 'Tool'           WHERE subject_type IN ('Tools');
UPDATE triples SET object_type  = 'Tool'           WHERE object_type  IN ('Tools');

UPDATE triples SET subject_type = 'API'            WHERE subject_type IN ('Apis');
UPDATE triples SET object_type  = 'API'            WHERE object_type  IN ('Apis');

UPDATE triples SET subject_type = 'Dashboard'      WHERE subject_type IN ('Dashboards');
UPDATE triples SET object_type  = 'Dashboard'      WHERE object_type  IN ('Dashboards');

UPDATE triples SET subject_type = 'Message'        WHERE subject_type IN ('Messages');
UPDATE triples SET object_type  = 'Message'        WHERE object_type  IN ('Messages');

UPDATE triples SET subject_type = 'Email'          WHERE subject_type IN ('Emails');
UPDATE triples SET object_type  = 'Email'          WHERE object_type  IN ('Emails');

UPDATE triples SET subject_type = 'Campaign'       WHERE subject_type IN ('Campaigns');
UPDATE triples SET object_type  = 'Campaign'       WHERE object_type  IN ('Campaigns');

UPDATE triples SET subject_type = 'Post'           WHERE subject_type IN ('Posts');
UPDATE triples SET object_type  = 'Post'           WHERE object_type  IN ('Posts');

UPDATE triples SET subject_type = 'Reel'           WHERE subject_type IN ('Reels');
UPDATE triples SET object_type  = 'Reel'           WHERE object_type  IN ('Reels');

UPDATE triples SET subject_type = 'Story'          WHERE subject_type IN ('Stories');
UPDATE triples SET object_type  = 'Story'          WHERE object_type  IN ('Stories');

UPDATE triples SET subject_type = 'Metric'         WHERE subject_type IN ('Metrics');
UPDATE triples SET object_type  = 'Metric'         WHERE object_type  IN ('Metrics');

UPDATE triples SET subject_type = 'Status'         WHERE subject_type IN ('Statuses');
UPDATE triples SET object_type  = 'Status'         WHERE object_type  IN ('Statuses');

UPDATE triples SET subject_type = 'Channel'        WHERE subject_type IN ('Channels');
UPDATE triples SET object_type  = 'Channel'        WHERE object_type  IN ('Channels');

UPDATE triples SET subject_type = 'Collection'     WHERE subject_type IN ('Collections');
UPDATE triples SET object_type  = 'Collection'     WHERE object_type  IN ('Collections');

UPDATE triples SET subject_type = 'Contact'        WHERE subject_type IN ('Contacts');
UPDATE triples SET object_type  = 'Contact'        WHERE object_type  IN ('Contacts');

UPDATE triples SET subject_type = 'Deal'           WHERE subject_type IN ('Deals');
UPDATE triples SET object_type  = 'Deal'           WHERE object_type  IN ('Deals');

UPDATE triples SET subject_type = 'File'           WHERE subject_type IN ('Files');
UPDATE triples SET object_type  = 'File'           WHERE object_type  IN ('Files');

UPDATE triples SET subject_type = 'Directory'      WHERE subject_type IN ('Directories');
UPDATE triples SET object_type  = 'Directory'      WHERE object_type  IN ('Directories');

UPDATE triples SET subject_type = 'Dataset'        WHERE subject_type IN ('Datasets');
UPDATE triples SET object_type  = 'Dataset'        WHERE object_type  IN ('Datasets');

UPDATE triples SET subject_type = 'Domain'         WHERE subject_type IN ('Industry');
UPDATE triples SET object_type  = 'Domain'         WHERE object_type  IN ('Industry');
